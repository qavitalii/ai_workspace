import { integrationRoutes } from "./integrations.js";
import { GB, outputStorage, isOutputLimit } from "./output-storage.js";
import { commandsFor, slashCommand } from "../commands.js";
import { accountUsage } from "./usage.js";
import { accountModels } from "./models.js";
import { chatFolders } from "./folders.js";
import { folderRoutes } from "./folder-routes.js";
import { sshRoutes } from "./ssh-routes.js";
import { awsRoutes } from "./aws.js";
import { skillEntries, skillRoutes } from "./skills.js";
import { projectRoutes } from "./project-routes.js";
import Fastify from "fastify";
import { proxyTrust } from "./proxy.js";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { inspectWorkspace } from "./files.js";
import { rasterImageFormat, rasterMime } from "../raster-image.js";
import { acquireWorkspace, releaseWorkspace } from "./leases.js";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { authRoutes, authenticated } from "./auth.js";
import { config } from "./config.js";
import { bus, event } from "./events.js";
import { safeName, seal, redact } from "./security.js";
import { normalizeGithubRepo } from "../shared.js";
import { concurrentTasks, modelDefaults } from "./settings.js";
import { createResourceMonitor } from "./resources.js";
import { updatePhase, updateRoutes } from "./updates.js";
import { disconnectAccount, deleteAccount } from "./accounts.js";
import { active, switchAccount } from "./worker.js";
import {
  workspacePath,
  createWorkspace,
  mainWorkspace,
  workspaceBy,
} from "./workspaces.js";
import { launch, type Running } from "./runtime.js";
import { removeChatSessions } from "./profiles.js";
import {
  github,
  initializeWorkspace,
  pushBranch,
  projectToken,
  reviewPublication,
  localChanges,
  validatePublication,
  commitReviewed,
} from "./git.js";
const effortSchema = z.enum([
  "",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const uuid = z.string().uuid();
const projectFields =
  "id,name,repo,base_branch,created_at,(github_token <> '') AS github_configured";
const chatFields =
  "c.*,w.name AS workspace_name,w.kind AS workspace_kind,w.branch,w.initialized";
async function verifyRepository(repo: string, token: string) {
  try {
    return await github("/repos/" + repo, "GET", undefined, token);
  } catch (e: any) {
    const messages: Record<number, string> = {
      401: "GitHub rejected this project's token. Check the token and try again.",
      403: "GitHub denied access. Check this project's token permissions or try again after the API rate limit resets.",
      404: "Repository not found or access denied. Check the repository address and add a token for this project if it is private.",
    };
    if (messages[e.githubStatus])
      throw Object.assign(new Error(messages[e.githubStatus]), {
        statusCode: e.githubStatus === 401 ? 400 : e.githubStatus,
      });
    throw e;
  }
}
const authRuns = new Map<
  string,
  { runtime: Running; events: any[]; timer: NodeJS.Timeout }
>();
const terminals = new Map<string, Running>();
function requestJobStop(id: string, runtime: Running | undefined) {
  if (!runtime) return;
  runtime.send({ type: "stop" });
  setTimeout(() => {
    if (active.get(id) === runtime)
      void runtime
        .stop()
        .catch((error) =>
          console.error("Could not stop task runner:", redact(String(error))),
        );
  }, 10000).unref();
}
const idOf = (req: any, key = "id") => uuid.parse(req.params[key]);
async function chatBy(id: string) {
  const c = (
    await db.query(
      "SELECT " +
        chatFields +
        " FROM chats c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1",
      [id],
    )
  ).rows[0];
  if (!c) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
  return c;
}
async function idle(id: string, connection: Pick<typeof db, "query"> = db) {
  if (
    (
      await connection.query(
        "SELECT 1 FROM jobs WHERE chat_id=$1 AND state IN ('running','waiting_approval','queued')",
        [id],
      )
    ).rowCount
  )
    throw Object.assign(new Error("Stop the current task first"), {
      statusCode: 409,
    });
}
export async function createApp() {
  const resources = createResourceMonitor();
  const terminalCleanups = new Set<() => Promise<void>>();
  const inlineImageQueue: Array<() => void> = [];
  let inlineImageReads = 0;
  async function reserveInlineImageRead() {
    // Inline images load automatically. Limit concurrent Docker reads and
    // keep the slot until the response has handed off its buffered file.
    if (inlineImageReads >= 2) {
      if (inlineImageQueue.length >= 24)
        throw Object.assign(
          new Error("Too many images are opening. Try again shortly."),
          {
            statusCode: 503,
          },
        );
      await new Promise<void>((resolve) => inlineImageQueue.push(resolve));
    } else {
      inlineImageReads++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = inlineImageQueue.shift();
      if (next) next();
      else inlineImageReads--;
    };
  }
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.body.password",
        "req.body.token",
        "req.body.code",
        "req.body.private_key",
        "req.body.passphrase",
      ],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: config.trustedProxyIps.trim()
      ? proxyTrust(config.trustedProxyIps)
      : false,
  });
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
  await app.register(multipart, {
    limits: { fileSize: config.maxFile, files: 1, fields: 4 },
  });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  updateRoutes(app, () => terminalCleanups.size > 0);
  await authRoutes(app);
  app.setErrorHandler((e: any, _req, reply) => {
    const code =
      e instanceof z.ZodError
        ? 400
        : e.code === "23505" || isOutputLimit(e)
          ? 409
          : e.statusCode || 500;
    reply.code(code).send({
      error:
        e instanceof z.ZodError
          ? "Invalid request data"
          : code >= 500
            ? "The operation could not be completed. Check the server status."
            : redact(e.message),
    });
    if (code >= 500)
      app.log.error({ message: redact(e.message) }, "Request failed");
  });
  integrationRoutes(app);
  folderRoutes(app);
  sshRoutes(app);
  awsRoutes(app);
  skillRoutes(app);
  app.get("/api/overview", async () => ({
    modelDefaults: await modelDefaults(),
    projects: (
      await db.query(
        "SELECT " + projectFields + " FROM projects ORDER BY created_at DESC",
      )
    ).rows,
    workspaces: (
      await db.query(
        "SELECT * FROM workspaces ORDER BY (kind='main') DESC,created_at",
      )
    ).rows,
    accounts: (
      await db.query("SELECT * FROM accounts ORDER BY priority,created_at")
    ).rows,
    chats: (
      await db.query(
        "SELECT " +
          chatFields +
          ",j.state FROM chats c JOIN workspaces w ON w.id=c.workspace_id LEFT JOIN LATERAL (SELECT state FROM jobs WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) j ON true ORDER BY c.created_at DESC",
      )
    ).rows,
  }));
  app.get("/api/search", async (req) => {
    const q = z.object({ q: z.string().max(200) }).parse(req.query);
    return (
      await db.query(
        "SELECT c.id,c.title,m.content FROM chats c JOIN messages m ON m.chat_id=c.id WHERE m.content ILIKE $1 OR c.title ILIKE $1 ORDER BY m.created_at DESC LIMIT 30",
        ["%" + q.q + "%"],
      )
    ).rows;
  });
  app.get("/api/system", async () => {
    const [metrics, maximum, jobs, output] = await Promise.all([
      resources.read(),
      concurrentTasks(),
      db.query(
        "SELECT count(*) FILTER (WHERE state IN ('running','waiting_approval'))::int running, count(*) FILTER (WHERE state='queued')::int queued, count(*) FILTER (WHERE state='waiting_account')::int waiting_accounts FROM jobs",
      ),
      outputStorage(),
    ]);
    return {
      output,
      resources: metrics,
      maxConcurrent: maximum,
      running: jobs.rows[0].running,
      queued: jobs.rows[0].queued,
      waitingAccounts: jobs.rows[0].waiting_accounts,
    };
  });
  app.post("/api/settings/output", async (req) => {
    const { limitGb } = z
      .object({ limitGb: z.number().min(0.01).max(10000) })
      .parse(req.body);
    await db.query("UPDATE output_storage SET limit_bytes=$1 WHERE id=1", [
      Math.round(limitGb * GB),
    ]);
    return outputStorage();
  });
  app.get("/api/settings/models", async () => modelDefaults());
  app.post("/api/settings/models/:provider", async (req) => {
    const provider = z
      .enum(["codex", "claude"])
      .parse((req.params as any).provider);
    const value = z
      .object({
        model: z.string().trim().min(1).max(100),
        effort: effortSchema.default(""),
      })
      .parse(req.body);
    await db.query(
      "INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ["model_default_" + provider, JSON.stringify(value)],
    );
    return { ok: true };
  });
  app.post("/api/settings/execution", async (req) => {
    const { maxConcurrent } = z
      .object({
        maxConcurrent: z.number().int().positive().refine(Number.isSafeInteger),
      })
      .parse(req.body);
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      await c.query(
        "INSERT INTO settings(key,value) VALUES('max_concurrent',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [String(maxConcurrent)],
      );
    });
    return { maxConcurrent };
  });
  projectRoutes(app);
  app.post("/api/projects", async (req) => {
    const p = z
      .object({
        repo: z.string().max(2048).default(""),
        token: z.string().min(10).max(500).optional(),
        name: z.string().min(1).max(100).optional(),
      })
      .parse(req.body);
    if (!p.repo.trim()) {
      if (!p.name?.trim())
        throw Object.assign(new Error("Enter a project name."), {
          statusCode: 400,
        });
      return transaction(async (c) => {
        const project = (
          await c.query(
            "INSERT INTO projects(id,name,repo) VALUES($1,$2,'') RETURNING " +
              projectFields,
            [randomUUID(), p.name!.trim()],
          )
        ).rows[0];
        await createWorkspace(project.id, "main", "Main folder", c);
        return project;
      });
    }
    const normalized = normalizeGithubRepo(p.repo);
    if (!normalized)
      throw Object.assign(
        new Error(
          "Enter owner/repository or a GitHub repository URL, such as https://github.com/owner/repository.",
        ),
        { statusCode: 400 },
      );
    p.repo = normalized;
    const repo = await verifyRepository(p.repo, p.token || "");
    return transaction(async (c) => {
      const project = (
        await c.query(
          "INSERT INTO projects(id,name,repo,base_branch,github_token) VALUES($1,$2,$3,$4,$5) RETURNING " +
            projectFields,
          [
            randomUUID(),
            p.name || repo.name,
            p.repo,
            repo.default_branch,
            p.token ? seal(p.token) : "",
          ],
        )
      ).rows[0];
      await createWorkspace(project.id, "main", "Main folder", c);
      return project;
    });
  });

  app.patch("/api/projects/:id", async (req) => {
    const id = idOf(req);
    const p = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        token: z.string().min(10).max(500).nullable().optional(),
      })
      .parse(req.body);
    const project = (await db.query("SELECT * FROM projects WHERE id=$1", [id]))
      .rows[0];
    if (!project)
      throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    if (p.token && !project.repo)
      throw Object.assign(new Error("This project has no GitHub repository."), {
        statusCode: 400,
      });
    if (p.token) await verifyRepository(project.repo, p.token);
    const result = await db.query(
      "UPDATE projects SET name=COALESCE($2,name),github_token=CASE WHEN $3 THEN $4 ELSE github_token END WHERE id=$1 RETURNING " +
        projectFields,
      [id, p.name || null, p.token !== undefined, p.token ? seal(p.token) : ""],
    );
    return result.rows[0];
  });
  app.post("/api/accounts", async (req) => {
    const a = z
      .object({
        provider: z.enum(["codex", "claude"]),
        name: z.string().min(1).max(80),
      })
      .parse(req.body);
    return (
      await db.query(
        "INSERT INTO accounts(id,provider,name) VALUES($1,$2,$3) RETURNING *",
        [randomUUID(), a.provider, a.name],
      )
    ).rows[0];
  });
  app.delete("/api/accounts/:id", async (req) => {
    const id = idOf(req);
    const result = await deleteAccount(
      id,
      z.object({ name: z.string() }).parse(req.body).name,
    );
    const auth = authRuns.get(id);
    if (auth) {
      clearTimeout(auth.timer);
      authRuns.delete(id);
    }
    return result;
  });
  app.patch("/api/accounts/:id", async (req) => {
    const id = idOf(req),
      a = z
        .object({
          name: z.string().min(1).max(80),
          priority: z.number().int().min(0).max(999),
        })
        .parse(req.body);
    await db.query("UPDATE accounts SET name=$2,priority=$3 WHERE id=$1", [
      id,
      a.name,
      a.priority,
    ]);
    return { ok: true };
  });
  app.post("/api/accounts/:id/auth", async (req) => {
    const id = idOf(req);
    if (authRuns.has(id)) return { ok: true };
    const a = await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        (
          await c.query(
            "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('running','waiting_approval')",
            [id],
          )
        ).rowCount
      )
        throw Object.assign(new Error("Account is busy"), { statusCode: 409 });
      const row = (
        await c.query(
          "UPDATE accounts SET status='authenticating' WHERE id=$1 AND status NOT IN ('authenticating','inspecting','disconnecting','deleting','delete_failed') RETURNING *",
          [id],
        )
      ).rows[0];
      if (!row)
        throw Object.assign(
          new Error("Account not found or sign-in already in progress"),
          {
            statusCode: 409,
          },
        );
      return row;
    });
    try {
      let early: any[] = [];
      // Wait for the profile copy-back before changing the account status.
      // The first outcome wins; later events for the same run are ignored.
      let finishing: Promise<void> | undefined;
      const finish = (s: { runtime: Running }, success: boolean) =>
        (finishing ??= (async () => {
          await s.runtime.stop().catch(() => {});
          const saved = (await s.runtime.profileSaved?.()) ?? true;
          await db.query(
            "UPDATE accounts SET status=$2,reset_at=NULL,model_catalog=NULL,models_updated_at=NULL WHERE id=$1 AND status='authenticating'",
            [id, success && saved ? "ready" : "disconnected"],
          );
        })());
      const runtime = await launch(
        null,
        id,
        (e) => {
          const s = authRuns.get(id);
          if (!s) {
            early.push(e);
            return;
          }
          s.events.push(e);
          if (s.events.length > 500) s.events.shift();
          if (e.type === "auth_complete") {
            clearTimeout(s.timer);
            setTimeout(() => {
              if (authRuns.get(id) === s) authRuns.delete(id);
            }, 60000).unref();
            void finish(s, e.success).catch(() => {});
          }
          if (e.type === "failed" || e.type === "exit") {
            clearTimeout(s.timer);
            void finish(s, false).catch(() => {});
          }
        },
        { signIn: true },
      );
      const timer = setTimeout(() => {
        authRuns.delete(id);
        void finish({ runtime }, false).catch(() => {});
      }, 600000);
      authRuns.set(id, { runtime, events: early, timer });
      runtime.send({ type: "auth", provider: a.provider });
      return { ok: true };
    } catch (e) {
      await db.query(
        "UPDATE accounts SET status='disconnected' WHERE id=$1 AND status='authenticating'",
        [id],
      );
      throw e;
    }
  });
  app.get("/api/accounts/:id/auth", async (req) => ({
    events: authRuns.get(idOf(req))?.events || [],
  }));
  app.post("/api/accounts/:id/auth-input", async (req) => {
    const s = authRuns.get(idOf(req));
    if (!s)
      throw Object.assign(new Error("Sign-in has completed or expired"), {
        statusCode: 409,
      });
    const { data } = z.object({ data: z.string().max(8000) }).parse(req.body);
    s.runtime.send({ type: "auth_input", data: data + "\r" });
    return { ok: true };
  });
  app.delete("/api/accounts/:id/auth", async (req) => {
    const id = idOf(req),
      s = authRuns.get(id);
    if (s) {
      clearTimeout(s.timer);
      await s.runtime.stop();
      authRuns.delete(id);
    }
    await db.query(
      "UPDATE accounts SET status='disconnected' WHERE id=$1 AND status='authenticating'",
      [id],
    );
    return { ok: true };
  });
  app.post("/api/accounts/:id/logout", async (req) =>
    disconnectAccount(idOf(req)),
  );
  app.post("/api/accounts/:id/recheck", async (req) => {
    const id = idOf(req);
    await db.query(
      "UPDATE accounts SET status='ready',reset_at=NULL WHERE id=$1 AND status='limited'",
      [id],
    );
    return { ok: true };
  });
  app.post("/api/accounts/:id/usage", async (req) => accountUsage(idOf(req)));
  app.post("/api/accounts/:id/models", async (req) => {
    const p = z
      .object({ refresh: z.boolean().default(false) })
      .parse(req.body || {});
    return accountModels(idOf(req), p.refresh);
  });
  const chatSchema = z.object({
    project_id: uuid.nullable().default(null),
    workspace_id: uuid.optional(),
    title: z.string().trim().max(160).default(""),
    provider: z.enum(["codex", "claude"]),
    account_id: uuid,
    model: z.string().max(100).default(""),
    effort: effortSchema.default(""),
    autonomous: z.boolean().default(false),
    handoff: z.enum(["manual", "auto"]).default("manual"),
  });
  app.post("/api/chats", async (req) => {
    const c = chatSchema.parse(req.body);
    const defaults = (await modelDefaults())[c.provider];
    if (!c.model && defaults) {
      c.model = defaults.model;
      if (!(req.body as any).effort)
        c.effort = effortSchema.parse(defaults.effort);
    }
    if (c.handoff === "auto" && !config.autoHandoff)
      throw Object.assign(
        new Error(
          "Automatic switching has not been enabled by the administrator",
        ),
        { statusCode: 400 },
      );
    if (
      !(
        await db.query("SELECT 1 FROM accounts WHERE id=$1 AND provider=$2", [
          c.account_id,
          c.provider,
        ])
      ).rowCount
    )
      throw Object.assign(new Error("Invalid account"), {
        statusCode: 400,
      });
    const id = randomUUID();
    await transaction(async (connection) => {
      await connection.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(
          await connection.query(
            "SELECT 1 FROM accounts WHERE id=$1 AND provider=$2 AND status NOT IN ('deleting','delete_failed')",
            [c.account_id, c.provider],
          )
        ).rowCount
      )
        throw Object.assign(new Error("Choose an available account."), {
          statusCode: 409,
        });
      const w = c.workspace_id
        ? await workspaceBy(c.workspace_id, connection)
        : c.project_id
          ? await mainWorkspace(c.project_id, connection)
          : await createWorkspace(
              null,
              "personal",
              c.title || "Personal folder " + id.slice(0, 8),
              connection,
              id,
            );
      if (w.status !== "ready")
        throw Object.assign(new Error("This folder is not ready."), {
          statusCode: 409,
        });
      if (w.project_id !== c.project_id)
        throw Object.assign(
          new Error("This folder does not belong to the selected project."),
          { statusCode: 400 },
        );
      await connection.query(
        "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,model,effort,autonomous,handoff,branch,auto_title,initialized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          id,
          c.project_id,
          w.id,
          c.title || "New chat",
          c.provider,
          c.account_id,
          c.model,
          c.effort,
          c.autonomous,
          c.handoff,
          w.branch,
          !c.title,
          w.initialized,
        ],
      );
    });
    return chatBy(id);
  });

  app.get("/api/chats/:id", async (req) => {
    const id = idOf(req);
    return {
      chat: await chatBy(id),
      messages: (
        await db.query(
          "SELECT * FROM messages WHERE chat_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows,
      attachments: (
        await db.query(
          "SELECT * FROM attachments WHERE chat_id=$1 ORDER BY created_at",
          [id],
        )
      ).rows,
      jobs: (
        await db.query(
          "SELECT * FROM jobs WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 20",
          [id],
        )
      ).rows,
      approvals: (
        await db.query(
          "SELECT a.* FROM approvals a JOIN jobs j ON j.id=a.job_id WHERE j.chat_id=$1 AND a.decision IS NULL",
          [id],
        )
      ).rows,
      events: (
        await db.query(
          "SELECT * FROM (SELECT * FROM events WHERE chat_id=$1 AND type IN ('handoff','tool','log','warning') ORDER BY id DESC LIMIT 100) e ORDER BY id",
          [id],
        )
      ).rows,
    };
  });
  app.patch("/api/chats/:id/title", async (req) => {
    const id = idOf(req);
    const { title } = z
      .object({ title: z.string().trim().min(1).max(160) })
      .parse(req.body);
    const result = await db.query(
      "UPDATE chats SET title=$2,auto_title=false WHERE id=$1 RETURNING id,title",
      [id, title],
    );
    if (!result.rowCount)
      throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
    return result.rows[0];
  });
  app.delete("/api/chats/:id", async (req) => {
    const id = idOf(req);
    await transaction(async (c) => {
      // Serialize with the scheduler, terminal leases and new messages.
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]))
          .rowCount
      )
        throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
      const jobs = (
        await c.query("SELECT id,state FROM jobs WHERE chat_id=$1 FOR UPDATE", [
          id,
        ])
      ).rows;
      if (
        jobs.some(
          (j) =>
            [
              "queued",
              "running",
              "waiting_approval",
              "waiting_account",
            ].includes(j.state) || active.has(j.id),
        )
      )
        throw Object.assign(
          new Error("Stop the current task before deleting this chat."),
          { statusCode: 409 },
        );
      if (
        (await c.query("SELECT 1 FROM workspace_leases WHERE chat_id=$1", [id]))
          .rowCount
      )
        throw Object.assign(
          new Error(
            "Close the terminal or wait for the file operation before deleting this chat.",
          ),
          { statusCode: 409 },
        );
      await c.query(
        "DELETE FROM approvals WHERE job_id IN (SELECT id FROM jobs WHERE chat_id=$1)",
        [id],
      );
      await c.query(
        "DELETE FROM events WHERE chat_id=$1 OR job_id IN (SELECT id FROM jobs WHERE chat_id=$1)",
        [id],
      );
      await c.query("DELETE FROM publications WHERE chat_id=$1", [id]);
      await c.query("DELETE FROM jobs WHERE chat_id=$1", [id]);
      await c.query(
        "UPDATE attachments SET chat_id=NULL,message_id=NULL WHERE chat_id=$1",
        [id],
      );
      await c.query("DELETE FROM messages WHERE chat_id=$1", [id]);
      await c.query("DELETE FROM chats WHERE id=$1", [id]);
    });
    // Native session transcripts are chat data; drop them with the chat.
    await removeChatSessions([id]).catch((error) =>
      console.error("Could not remove chat sessions", error),
    );
    return { ok: true, cleanupPending: false };
  });

  app.patch("/api/chats/:id/model", async (req) => {
    const id = idOf(req);
    const p = z
      .object({
        model: z.string().trim().min(1).max(100),
        effort: effortSchema,
      })
      .parse(req.body);
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]))
          .rowCount
      )
        throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
      await idle(id);
      await c.query(
        "UPDATE chats SET resolved_model=CASE WHEN model=$2 THEN resolved_model ELSE '' END,resolved_effort=CASE WHEN model=$2 AND effort=$3 THEN resolved_effort ELSE '' END,model=$2,effort=$3 WHERE id=$1",
        [id, p.model, p.effort],
      );
    });
    return { ok: true };
  });
  app.patch("/api/chats/:id/permissions", async (req) => {
    const id = idOf(req);
    const { autonomous } = z
      .object({ autonomous: z.boolean() })
      .parse(req.body);
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]))
          .rowCount
      )
        throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
      await idle(id, c);
      await c.query("UPDATE chats SET autonomous=$2 WHERE id=$1", [
        id,
        autonomous,
      ]);
    });
    return { ok: true };
  });
  app.patch("/api/chats/:id", async (req) => {
    const id = idOf(req);
    await idle(id);
    const p = z
      .object({
        title: z.string().trim().min(1).max(160),
        model: z.string().max(100),
        effort: effortSchema,
        autonomous: z.boolean(),
        handoff: z.enum(["manual", "auto"]),
      })
      .parse(req.body);
    if (p.handoff === "auto" && !config.autoHandoff)
      throw Object.assign(new Error("Automatic handoff disabled"), {
        statusCode: 400,
      });
    await db.query(
      "UPDATE chats SET title=$2,auto_title=false,resolved_model=CASE WHEN model=$3 THEN resolved_model ELSE '' END,resolved_effort=CASE WHEN model=$3 AND effort=$4 THEN resolved_effort ELSE '' END,model=$3,effort=$4,autonomous=$5,handoff=$6 WHERE id=$1",
      [id, p.title, p.model, p.effort, p.autonomous, p.handoff],
    );
    return { ok: true };
  });
  app.post("/api/chats/:id/mode", async (req) => {
    const id = idOf(req),
      p = z.object({ mode: z.enum(["default", "plan"]) }).parse(req.body);
    await transaction(async (c) => {
      await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]);
      await idle(id);
      await c.query("UPDATE chats SET mode=$2 WHERE id=$1", [id, p.mode]);
    });
    return { ok: true };
  });
  app.post("/api/chats/:id/messages", async (req) => {
    const id = idOf(req),
      p = z
        .object({
          content: z.string().max(100000),
          client_id: uuid,
          attachment_ids: z.array(uuid).max(config.maxAttachments).default([]),
        })
        .parse(req.body);
    if (!p.content.trim() && !p.attachment_ids.length)
      throw Object.assign(new Error("Add a message or a file"), {
        statusCode: 400,
      });
    return transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      const chat = (
        await c.query("SELECT * FROM chats WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!chat)
        throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
      if (
        chat.account_id &&
        (
          await c.query(
            "SELECT 1 FROM accounts WHERE id=$1 AND status IN ('deleting','delete_failed')",
            [chat.account_id],
          )
        ).rowCount
      )
        throw Object.assign(
          new Error("Choose another account before sending a message."),
          { statusCode: 409 },
        );
      if ((await workspaceBy(chat.workspace_id, c)).status !== "ready")
        throw Object.assign(new Error("This folder is not ready."), {
          statusCode: 409,
        });
      const previous = (
        await c.query(
          "SELECT id FROM messages WHERE chat_id=$1 AND client_id=$2",
          [id, p.client_id],
        )
      ).rows[0];
      if (previous) return previous;
      const shortcut = slashCommand(p.content);
      if (shortcut) {
        const command = commandsFor(chat.provider, chat.native_commands).find(
          (c) => c.name === shortcut.name,
        );
        if (
          !command ||
          command.unavailable ||
          (!command.native && shortcut.name !== "plan")
        )
          throw Object.assign(
            new Error(
              command?.unavailable ||
                "Use the command menu for supported actions. Unknown commands are not sent as prompts.",
            ),
            { statusCode: 400 },
          );
        if (shortcut.name === "plan") {
          if (!shortcut.arguments.trim())
            throw Object.assign(
              new Error(
                "Add a task after /plan, or switch mode using the command menu.",
              ),
              { statusCode: 400 },
            );
          await c.query("UPDATE chats SET mode='plan' WHERE id=$1", [id]);
        }
        if (
          shortcut.name === "compact" &&
          (!chat.session_id || chat.session_account !== chat.account_id)
        )
          throw Object.assign(
            new Error(
              "Send a message with this account before compacting its session.",
            ),
            { statusCode: 400 },
          );
        if (command.native && p.attachment_ids.length)
          throw Object.assign(
            new Error(
              "Send attachments in a separate message before running this command.",
            ),
            { statusCode: 400 },
          );
        if (
          chat.provider === "codex" &&
          shortcut.name === "compact" &&
          shortcut.arguments
        )
          throw Object.assign(
            new Error("Codex /compact does not take arguments."),
            { statusCode: 400 },
          );
      }
      const files = (
        await c.query(
          "SELECT id FROM attachments WHERE chat_id=$1 AND id=ANY($2::uuid[]) AND message_id IS NULL FOR UPDATE",
          [id, p.attachment_ids],
        )
      ).rows;
      if (files.length !== new Set(p.attachment_ids).size)
        throw Object.assign(
          new Error("These attachments do not belong to this message"),
          { statusCode: 400 },
        );
      const mid = randomUUID(),
        jid = randomUUID();
      await c.query(
        "INSERT INTO messages(id,chat_id,role,content,client_id) VALUES($1,$2,$3,$4,$5)",
        [mid, id, "user", p.content, p.client_id],
      );
      const title = p.content.trim().replace(/\s+/g, " ");
      if (title)
        await c.query(
          "UPDATE chats SET title=$2,auto_title=false WHERE id=$1 AND auto_title=true",
          [
            id,
            Array.from(title).slice(0, 64).join("") +
              (Array.from(title).length > 64 ? "…" : ""),
          ],
        );
      await c.query(
        "UPDATE attachments SET message_id=$1 WHERE id=ANY($2::uuid[])",
        [mid, p.attachment_ids],
      );
      await c.query(
        "INSERT INTO jobs(id,chat_id,message_id) VALUES($1,$2,$3)",
        [jid, id, mid],
      );
      return { id: mid, job_id: jid };
    });
  });
  app.post("/api/chats/:id/continue", async (req) => {
    const id = idOf(req);
    await idle(id);
    return transaction(async (c) => {
      await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]);
      const j = (
        await c.query(
          "SELECT * FROM jobs WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      if (!j)
        throw Object.assign(new Error("There is no task to continue"), {
          statusCode: 400,
        });
      if (j.state === "waiting_account") {
        await c.query(
          "UPDATE jobs SET state='queued',error=NULL,cancel_requested=false WHERE id=$1",
          [j.id],
        );
        return { ok: true };
      }
      await c.query(
        "INSERT INTO jobs(id,chat_id,message_id,attempt) VALUES($1,$2,$3,1)",
        [randomUUID(), id, j.message_id],
      );
      return { ok: true };
    });
  });
  app.post("/api/chats/:id/stop", async (req) => {
    const id = idOf(req);
    const running = await transaction(async (c) => {
      // Prevent a queued continuation from being claimed between these updates.
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      const stopped = await c.query(
        "UPDATE jobs SET cancel_requested=true WHERE chat_id=$1 AND state IN ('running','waiting_approval') RETURNING id",
        [id],
      );
      await c.query(
        "UPDATE jobs SET state='cancelled' WHERE chat_id=$1 AND state IN ('queued','waiting_account')",
        [id],
      );
      return stopped.rows;
    });
    for (const job of running) requestJobStop(job.id, active.get(job.id));
    await event(id, null, "status", { state: "cancelled" });
    return { ok: true };
  });
  app.post("/api/chats/:id/switch", async (req) => {
    const id = idOf(req),
      p = z.object({ account_id: uuid }).parse(req.body);
    const j = (
      await db.query(
        "SELECT id FROM jobs WHERE chat_id=$1 AND state='waiting_account'",
        [id],
      )
    ).rows[0];
    await switchAccount(id, p.account_id, j?.id);
    return { ok: true };
  });
  app.post("/api/approvals/:id", async (req) => {
    const id = idOf(req),
      { allow } = z.object({ allow: z.boolean() }).parse(req.body);
    const plan = await transaction(async (c) => {
      const a = (
        await c.query(
          "SELECT * FROM approvals WHERE id=$1 AND decision IS NULL AND kind IN ('permission','plan_exit') FOR UPDATE",
          [id],
        )
      ).rows[0];
      const runtime = a && active.get(a.job_id);
      if (!runtime)
        throw Object.assign(new Error("This request is no longer active"), {
          statusCode: 409,
        });
      if (allow && a.details == null)
        throw Object.assign(
          new Error(
            "Action details are unavailable. Deny this request and retry the action.",
          ),
          { statusCode: 409 },
        );
      const planApproved = allow && a.kind === "plan_exit";
      if (planApproved) {
        if (typeof a.details !== "string" || !a.details.trim())
          throw Object.assign(new Error("The proposed plan is unavailable."), {
            statusCode: 409,
          });
        const updated = await c.query(
          "UPDATE chats SET mode='default' WHERE provider='claude' AND mode='plan' AND id=(SELECT chat_id FROM jobs WHERE id=$1 AND state='waiting_approval' AND NOT cancel_requested FOR UPDATE)",
          [a.job_id],
        );
        if (!updated.rowCount)
          throw Object.assign(new Error("This plan is no longer active"), {
            statusCode: 409,
          });
      }
      await c.query("UPDATE approvals SET decision=$2 WHERE id=$1", [
        id,
        allow,
      ]);
      if (!planApproved)
        runtime.send({ type: "approve", id: a.request_id, allow });
      await c.query(
        "UPDATE jobs SET state='running' WHERE id=$1 AND state='waiting_approval' AND NOT EXISTS (SELECT 1 FROM approvals WHERE job_id=$1 AND decision IS NULL)",
        [a.job_id],
      );
      return planApproved ? { id: a.job_id, runtime } : undefined;
    });
    if (plan) requestJobStop(plan.id, plan.runtime);
    return { ok: true };
  });
  app.post("/api/questions/:id", async (req) => {
    const id = idOf(req),
      p = z
        .object({
          answers: z.record(
            z.string(),
            z.object({
              answers: z.array(z.string().min(1).max(10000)).min(1).max(20),
            }),
          ),
        })
        .parse(req.body);
    await transaction(async (c) => {
      const a = (
        await c.query(
          "SELECT * FROM approvals WHERE id=$1 AND decision IS NULL AND kind='question' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!a || !active.has(a.job_id))
        throw Object.assign(new Error("This question is no longer active"), {
          statusCode: 409,
        });
      const ids = a.questions.map((q: any) => q.id);
      if (
        ids.length !== Object.keys(p.answers).length ||
        ids.some((key: string) => !p.answers[key])
      )
        throw Object.assign(
          new Error("Answer every question before continuing."),
          { statusCode: 400 },
        );
      await c.query("UPDATE approvals SET decision=true WHERE id=$1", [id]);
      active
        .get(a.job_id)!
        .send({ type: "answer", id: a.request_id, answers: p.answers });
      await c.query(
        "UPDATE jobs SET state='running' WHERE id=$1 AND state='waiting_approval' AND NOT EXISTS (SELECT 1 FROM approvals WHERE job_id=$1 AND decision IS NULL)",
        [a.job_id],
      );
    });
    return { ok: true };
  });
  app.post("/api/chats/:id/attachments", async (req, reply) => {
    const chatId = idOf(req);
    await chatBy(chatId);
    const clientId = uuid.parse((req.query as any).client_id);
    const previous = (
      await db.query(
        "SELECT * FROM attachments WHERE chat_id=$1 AND client_id=$2",
        [chatId, clientId],
      )
    ).rows[0];
    if (previous) return previous;
    const part = await req.file();
    if (!part)
      throw Object.assign(new Error("No file provided"), { statusCode: 400 });
    const name = safeName(part.filename),
      id = randomUUID(),
      storage = id + "-" + name,
      dir = path.join(config.data, "uploads");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, storage);
    try {
      await pipeline(
        part.file,
        createWriteStream(dest, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated)
        throw Object.assign(new Error("File is too large"), {
          statusCode: 413,
        });
      const s = await stat(dest);
      return await transaction(async (c) => {
        await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [chatId]);
        if (
          Number(
            (
              await c.query(
                "SELECT count(*) n FROM attachments WHERE chat_id=$1 AND message_id IS NULL",
                [chatId],
              )
            ).rows[0].n,
          ) >= config.maxAttachments
        )
          throw Object.assign(new Error("Too many attachments"), {
            statusCode: 400,
          });
        return (
          await c.query(
            "INSERT INTO attachments(id,chat_id,workspace_id,name,mime,size,storage_name,client_id) VALUES($1,$2,(SELECT workspace_id FROM chats WHERE id=$2),$3,$4,$5,$6,$7) RETURNING *",
            [id, chatId, name, part.mimetype, s.size, storage, clientId],
          )
        ).rows[0];
      });
    } catch (e) {
      await unlink(dest).catch(() => {});
      if ((e as any).code === "23505")
        return (
          await db.query(
            "SELECT * FROM attachments WHERE chat_id=$1 AND client_id=$2",
            [chatId, clientId],
          )
        ).rows[0];
      throw e;
    }
  });
  app.delete("/api/attachments/:id", async (req) => {
    const f = (
      await db.query(
        "DELETE FROM attachments WHERE id=$1 AND message_id IS NULL AND chat_id IS NOT NULL RETURNING *",
        [idOf(req)],
      )
    ).rows[0];
    if (f)
      await unlink(path.join(config.data, "uploads", f.storage_name)).catch(
        () => {},
      );
    return { ok: true };
  });
  app.get("/api/attachments/:id", async (req, reply) => {
    const f = (
      await db.query("SELECT * FROM attachments WHERE id=$1", [idOf(req)])
    ).rows[0];
    if (!f) return reply.code(404).send();
    const image = [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ].includes(f.mime);
    reply
      .header("Cache-Control", "private, no-store")
      .header(
        "Content-Disposition",
        (image ? "inline" : "attachment") +
          "; filename*=UTF-8''" +
          encodeURIComponent(f.name),
      )
      .type(image ? f.mime : "application/octet-stream");
    return reply.send(
      createReadStream(path.join(config.data, "uploads", f.storage_name)),
    );
  });
  app.get("/api/chats/:id/context", async (req) => {
    const id = idOf(req),
      chat = await chatBy(id);
    const entries = chat.initialized
      ? await inspectWorkspace(id, "", "index")
      : [];
    entries.push(...(await skillEntries(chat.project_id)));
    const folders = await chatFolders(id);
    for (const f of folders)
      entries.push({
        kind: "file",
        name: "Folders/" + f.name,
        path: "/workspace/.workspace-folders/" + f.name,
      });
    return { entries, initialized: chat.initialized };
  });
  app.get("/api/chats/:id/files", async (req) => {
    const id = idOf(req);
    await chatBy(id);
    const rel = z
      .string()
      .max(1000)
      .parse((req.query as any).path || "");
    return inspectWorkspace(id, rel, "list");
  });
  app.get("/api/chats/:id/file", async (req, reply) => {
    const id = idOf(req);
    await chatBy(id);
    const file = z
      .object({
        path: z.string().min(1).max(1000),
        inline: z.literal("1").optional(),
      })
      .parse(req.query);
    const release = file.inline ? await reserveInlineImageRead() : undefined;
    try {
      if (reply.raw.destroyed) {
        release?.();
        return;
      }
      const data = await inspectWorkspace(id, file.path, "file");
      let mime = "application/octet-stream";
      if (file.inline) {
        const format = rasterImageFormat(data);
        if (!format)
          throw Object.assign(
            new Error("This file cannot be displayed as an image."),
            {
              statusCode: 415,
            },
          );
        mime = rasterMime[format];
      }
      if (release) {
        if (reply.raw.destroyed) {
          release();
          return;
        }
        reply.raw.once("finish", release);
        reply.raw.once("close", release);
      }
      return reply
        .header("Cache-Control", "no-store")
        .header(
          "Content-Disposition",
          (file.inline ? "inline" : "attachment") +
            "; filename*=UTF-8''" +
            encodeURIComponent(path.basename(file.path)),
        )
        .type(mime)
        .send(data);
    } catch (error) {
      release?.();
      throw error;
    }
  });
  app.get("/api/chats/:id/diff", async (req) => {
    const chat = await chatBy(idOf(req));
    if (
      !chat.project_id ||
      !(
        await db.query("SELECT repo FROM projects WHERE id=$1", [
          chat.project_id,
        ])
      ).rows[0]?.repo
    )
      throw Object.assign(new Error("This chat has no Git repository."), {
        statusCode: 409,
      });
    return localChanges(chat);
  });
  app.post("/api/chats/:id/publication-review", async (req) => {
    const chat = await chatBy(idOf(req));
    const { target } = z
      .object({ target: z.enum(["commit", "push"]) })
      .parse(req.body);
    const project = (
      await db.query("SELECT * FROM projects WHERE id=$1", [chat.project_id])
    ).rows[0];
    if (!project?.repo)
      throw Object.assign(new Error("This chat has no Git repository."), {
        statusCode: 409,
      });
    await acquireWorkspace(chat.id, "publication review");
    try {
      return await reviewPublication(chat, project, target === "push");
    } finally {
      await releaseWorkspace(chat.id);
    }
  });
  app.post("/api/chats/:id/git", async (req) => {
    const id = idOf(req);
    await idle(id);
    if (terminals.has(id))
      throw Object.assign(new Error("Close the terminal before publishing"), {
        statusCode: 409,
      });
    const chat = await chatBy(id);
    if (
      !chat.project_id ||
      !(
        await db.query("SELECT repo FROM projects WHERE id=$1", [
          chat.project_id,
        ])
      ).rows[0]?.repo
    )
      throw Object.assign(
        new Error(
          "This chat has no Git repository. Files and terminal remain available.",
        ),
        { statusCode: 409 },
      );
    const p = z
      .object({
        action: z.enum(["commit", "push", "pr"]),
        review_token: z.string().min(1).max(10000),
        message: z.string().trim().max(500).default(""),
        client_id: uuid,
      })
      .refine((value) => value.action === "push" || !!value.message, {
        message: "A commit message or pull request title is required.",
      })
      .parse(req.body);
    const previous = (
      await db.query("SELECT * FROM publications WHERE id=$1", [p.client_id])
    ).rows[0];
    if (previous) {
      if (previous.chat_id !== id || previous.kind !== p.action)
        throw Object.assign(
          new Error("Publication request belongs to a different action."),
          { statusCode: 409 },
        );
      return previous;
    }
    await acquireWorkspace(id, "publication");
    try {
      await db.query(
        "INSERT INTO publications(id,chat_id,kind,status) VALUES($1,$2,$3,'running')",
        [p.client_id, id, p.action],
      );
    } catch (e) {
      await releaseWorkspace(id);
      throw e;
    }
    try {
      const project = (
        await db.query("SELECT * FROM projects WHERE id=$1", [chat.project_id])
      ).rows[0];
      const review = await validatePublication(chat, project, p.review_token);
      let result: any = {};
      if (p.action === "commit") {
        result.output = await commitReviewed(review, p.message);
      } else if (p.action === "push") {
        result.output = await pushBranch(chat, project, review);
      } else {
        if (review.remote === null)
          throw Object.assign(
            new Error(
              "Refresh the outgoing commits review before creating a pull request.",
            ),
            { statusCode: 409 },
          );
        const remote = await github(
          "/repos/" +
            project.repo +
            "/git/ref/heads/" +
            encodeURIComponent(chat.branch),
          "GET",
          undefined,
          projectToken(project),
        );
        if (remote.object.sha !== review.head)
          throw Object.assign(
            new Error(
              "Push the reviewed commits before creating a pull request.",
            ),
            { statusCode: 409 },
          );
        const existing = await github(
          "/repos/" +
            project.repo +
            "/pulls?head=" +
            encodeURIComponent(project.repo.split("/")[0] + ":" + chat.branch) +
            "&state=open",
          "GET",
          undefined,
          projectToken(project),
        );
        result =
          existing[0] ||
          (await github(
            "/repos/" + project.repo + "/pulls",
            "POST",
            {
              title: p.message,
              head: chat.branch,
              base: project.base_branch,
              body: "Created with AI Workspace.",
            },
            projectToken(project),
          ));
      }
      await db.query(
        "UPDATE publications SET status='completed',result=$2 WHERE id=$1",
        [p.client_id, result],
      );
      await event(id, null, "publication", { action: p.action, result });
      return result;
    } catch (e) {
      await db.query("UPDATE publications SET status='unknown' WHERE id=$1", [
        p.client_id,
      ]);
      throw e;
    } finally {
      await releaseWorkspace(id);
    }
  });
  app.post("/api/push", async (req) => {
    const s = z
      .object({
        endpoint: z.url().refine((v) => new URL(v).protocol === "https:"),
        keys: z.object({
          p256dh: z.string().max(200),
          auth: z.string().max(200),
        }),
      })
      .parse(req.body);
    const host = new URL(s.endpoint).hostname;
    if (
      ![
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
      ].some((h) => host === h || host.endsWith("." + h))
    )
      throw Object.assign(new Error("Unsupported push service"), {
        statusCode: 400,
      });
    await db.query(
      "INSERT INTO push_subscriptions VALUES($1,$2) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription",
      [s.endpoint, s],
    );
    return { ok: true };
  });
  app.get("/api/events", { websocket: true }, (socket, req) => {
    const authTimer = setInterval(() => {
      void authenticated(req.cookies.session)
        .then((ok) => {
          if (!ok) socket.close(1008);
        })
        .catch(() => socket.close(1011));
    }, 60000);
    socket.on("close", () => clearInterval(authTimer));
    let buffering = true,
      buffer: any[] = [];
    const chatId = (req.query as any).chat_id;
    const after = String((req.query as any).after || "0");
    if (!uuid.safeParse(chatId).success || !/^\d{1,20}$/.test(after)) {
      socket.close(1008);
      return;
    }
    const send = (e: any) => {
      if (e.chat_id === chatId && socket.readyState === 1) {
        if (socket.bufferedAmount > 4 * 1024 * 1024)
          socket.close(1013, "Reconnect to catch up");
        else socket.send(JSON.stringify(e));
      }
    };
    let bufferedBytes = 0;
    const listener = (e: any) => {
      if (e.chat_id !== chatId || socket.readyState !== 1) return;
      if (!buffering) return send(e);
      bufferedBytes += Buffer.byteLength(JSON.stringify(e));
      if (bufferedBytes > 4 * 1024 * 1024) {
        buffer = [];
        socket.close(1013, "Reconnect to catch up");
      } else buffer.push(e);
    };
    const refresh = (id: string) => {
      if (id === chatId && socket.readyState === 1)
        socket.send(JSON.stringify({ type: "refresh" }));
    };
    const workspaceSync = (id: string) => {
      if (id === chatId && socket.readyState === 1)
        socket.send(JSON.stringify({ type: "workspace-sync" }));
    };
    bus.on("event", listener);
    bus.on("refresh", refresh);
    bus.on("workspace-sync", workspaceSync);
    socket.on("close", () => {
      bus.off("event", listener);
      bus.off("refresh", refresh);
      bus.off("workspace-sync", workspaceSync);
    });
    void (async () => {
      try {
        let cursor = after;
        while (socket.readyState === 1) {
          const rows = (
            await db.query(
              "SELECT * FROM events WHERE chat_id=$1 AND id>$2 ORDER BY id LIMIT 20",
              [chatId, cursor],
            )
          ).rows;
          for (const e of rows) send(e);
          if (rows.length) cursor = rows.at(-1).id;
          if (rows.length < 20) break;
        }
        for (const e of buffer) if (BigInt(e.id) > BigInt(cursor)) send(e);
        buffer = [];
        buffering = false;
      } catch {
        socket.close(1011);
      }
    })();
  });
  app.get("/api/chats/:id/terminal", { websocket: true }, (socket, req) => {
    const id = idOf(req);
    const authTimer = setInterval(() => {
      void authenticated(req.cookies.session)
        .then((ok) => {
          if (!ok) socket.close(1008);
        })
        .catch(() => socket.close(1011));
    }, 60000);
    let runtime: Running | undefined,
      closed = false,
      leased = false;
    let starting: Promise<void>, cleaning: Promise<void> | undefined;
    const cleanup = () =>
      (cleaning ||= (async () => {
        // A socket can close (or a runner can fail) before launch returns.
        // Keep the lease until that runner has been obtained and stopped.
        await starting;
        await runtime?.stop();
        if (leased) {
          await releaseWorkspace(id);
          leased = false;
        }
        if (runtime && terminals.get(id) === runtime) terminals.delete(id);
        terminalCleanups.delete(cleanup);
      })().catch((error) => {
        cleaning = undefined;
        throw error;
      }));
    terminalCleanups.add(cleanup);
    function disconnect(error?: string) {
      if (!closed && error && socket.readyState === 1)
        socket.send(
          JSON.stringify({ type: "terminal", data: "\r\n" + error + "\r\n" }),
        );
      closed = true;
      clearInterval(authTimer);
      if (socket.readyState === 1) socket.close(error ? 1011 : 1000);
      // Do not wait for the WebSocket close handshake to release the folder.
      void cleanup().catch((error) => {
        app.log.error(
          { message: redact(error.message) },
          "Terminal cleanup failed",
        );
      });
    }
    starting = (async () => {
      try {
        const phase = await updatePhase();
        if (phase === "waiting" || phase === "updating")
          throw new Error(
            "Workspace is preparing an update. Open the terminal after it restarts.",
          );
        const chat = await chatBy(id);
        await idle(id);
        if (terminals.has(id)) throw new Error("Terminal already open");
        await acquireWorkspace(id, "terminal");
        leased = true;
        if (closed) return;
        await initializeWorkspace(chat);
        runtime = await launch(id, null, (e) => {
          if (closed) return;
          if (e.type === "failed") disconnect(e.error || "Terminal failed.");
          else if (e.type === "exit" || e.type === "interrupted") disconnect();
          else if (socket.readyState === 1) socket.send(JSON.stringify(e));
        });
        if (closed) return;
        terminals.set(id, runtime);
        runtime.send({ type: "terminal", data: "" });
        if (runtime.awsWarning && socket.readyState === 1)
          socket.send(
            JSON.stringify({
              type: "terminal",
              data: "\r\nWarning: " + runtime.awsWarning + "\r\n",
            }),
          );
      } catch (e: any) {
        disconnect(e.message);
      }
    })();
    socket.on("message", (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (
          m.type === "terminal" &&
          typeof m.data === "string" &&
          m.data.length < 65536
        )
          runtime?.send(m);
        if (
          m.type === "resize" &&
          Number.isInteger(m.cols) &&
          Number.isInteger(m.rows)
        )
          runtime?.send(m);
      } catch {
        socket.close(1008);
      }
    });
    socket.on("close", () => disconnect());
  });
  await app.register(serveStatic, {
    root: path.resolve("dist/web"),
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Not found" })
      : reply.sendFile("index.html"),
  );
  app.addHook("onClose", async () => {
    for (const s of authRuns.values()) {
      clearTimeout(s.timer);
      await s.runtime.stop();
    }
    await Promise.all([...terminalCleanups].map((cleanup) => cleanup()));
  });
  return app;
}
