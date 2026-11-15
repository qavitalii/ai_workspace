import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import serveStatic from "@fastify/static";
import { inspectWorkspace } from "./files.js";
import { acquireWorkspace, releaseWorkspace } from "./leases.js";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  unlink,
  readdir,
  stat,
  readFile,
  statfs,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { authRoutes, authenticated } from "./auth.js";
import { config } from "./config.js";
import { bus, event } from "./events.js";
import { safeName, seal, confined, redact } from "./security.js";
import { validRepo } from "../shared.js";
import { active, switchAccount } from "./worker.js";
import { launch, workspace, type Running } from "./runtime.js";
import { git, github, initializeWorkspace, pushBranch } from "./git.js";
const uuid = z.string().uuid();
const authRuns = new Map<
  string,
  { runtime: Running; events: any[]; timer: NodeJS.Timeout }
>();
const terminals = new Map<string, Running>();
const idOf = (req: any, key = "id") => uuid.parse(req.params[key]);
async function chatBy(id: string) {
  const c = (await db.query("SELECT * FROM chats WHERE id=$1", [id])).rows[0];
  if (!c) throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
  return c;
}
async function idle(id: string) {
  if (
    (
      await db.query(
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
  const app = Fastify({
    logger: {
      level: "info",
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.body.password",
        "req.body.token",
        "req.body.code",
      ],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
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
  await authRoutes(app);
  app.setErrorHandler((e: any, _req, reply) => {
    const code =
      e instanceof z.ZodError
        ? 400
        : e.code === "23505"
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
  app.get("/api/overview", async () => ({
    projects: (
      await db.query("SELECT * FROM projects ORDER BY created_at DESC")
    ).rows,
    accounts: (
      await db.query("SELECT * FROM accounts ORDER BY priority,created_at")
    ).rows,
    chats: (
      await db.query(
        "SELECT c.*,j.state FROM chats c LEFT JOIN LATERAL (SELECT state FROM jobs WHERE chat_id=c.id ORDER BY created_at DESC LIMIT 1) j ON true ORDER BY c.created_at DESC",
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
    const fs = await statfs(config.data);
    return {
      freeBytes: fs.bavail * fs.bsize,
      totalBytes: fs.blocks * fs.bsize,
      running: active.size,
      githubConfigured: !!(
        await db.query("SELECT 1 FROM settings WHERE key='github_token'")
      ).rowCount,
    };
  });
  app.post("/api/settings/github", async (req) => {
    const { token } = z
      .object({ token: z.string().min(10).max(500) })
      .parse(req.body);
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!r.ok)
      throw Object.assign(new Error("GitHub rejected this token"), {
        statusCode: 400,
      });
    await db.query(
      "INSERT INTO settings(key,value) VALUES('github_token',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [seal(token)],
    );
    return { ok: true };
  });
  app.post("/api/projects", async (req) => {
    const p = z
      .object({
        repo: z.string().refine(validRepo),
        name: z.string().min(1).max(100).optional(),
      })
      .parse(req.body);
    const repo = await github("/repos/" + p.repo);
    return (
      await db.query(
        "INSERT INTO projects(id,name,repo,base_branch) VALUES($1,$2,$3,$4) RETURNING *",
        [randomUUID(), p.name || repo.name, p.repo, repo.default_branch],
      )
    ).rows[0];
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
          "UPDATE accounts SET status='authenticating' WHERE id=$1 AND status NOT IN ('authenticating','inspecting') RETURNING *",
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
      const runtime = await launch(null, id, (e) => {
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
          void s.runtime
            .stop()
            .then(() =>
              db.query(
                "UPDATE accounts SET status=$2,reset_at=NULL WHERE id=$1 AND status='authenticating'",
                [id, e.success ? "ready" : "disconnected"],
              ),
            )
            .catch(() => {});
        }
        if (e.type === "failed" || e.type === "exit") {
          clearTimeout(s.timer);
          void s.runtime.stop();
          void db.query(
            "UPDATE accounts SET status='disconnected' WHERE id=$1",
            [id],
          );
        }
      });
      const timer = setTimeout(() => {
        void runtime.stop();
        authRuns.delete(id);
        void db.query(
          "UPDATE accounts SET status='disconnected' WHERE id=$1 AND status='authenticating'",
          [id],
        );
      }, 600000);
      authRuns.set(id, { runtime, events: early, timer });
      runtime.send({ type: "auth", provider: a.provider });
      return { ok: true };
    } catch (e) {
      await db.query("UPDATE accounts SET status='disconnected' WHERE id=$1", [
        id,
      ]);
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
  app.post("/api/accounts/:id/recheck", async (req) => {
    const id = idOf(req);
    await db.query(
      "UPDATE accounts SET status='ready',reset_at=NULL WHERE id=$1 AND status='limited'",
      [id],
    );
    return { ok: true };
  });
  app.post("/api/accounts/:id/models", async (req) => {
    const id = idOf(req),
      a = await transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(417028)");
        if (
          (
            await c.query(
              "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('running','waiting_approval')",
              [id],
            )
          ).rowCount
        )
          throw Object.assign(new Error("Account is busy"), {
            statusCode: 409,
          });
        const a = (
          await c.query(
            "UPDATE accounts SET status='inspecting' WHERE id=$1 AND status='ready' RETURNING *",
            [id],
          )
        ).rows[0];
        if (!a)
          throw Object.assign(new Error("Account unavailable"), {
            statusCode: 409,
          });
        return a;
      });
    let r: Running | undefined;
    try {
      return await new Promise<any>(async (resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Model request timed out")),
          30000,
        );
        try {
          r = await launch(null, id, (e) => {
            if (e.type === "models") {
              clearTimeout(timer);
              resolve(e.models);
            }
            if (e.type === "failed") {
              clearTimeout(timer);
              reject(new Error(e.error));
            }
          });
          r.send({ type: "models", provider: a.provider });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
    } finally {
      await r?.stop();
      await db.query(
        "UPDATE accounts SET status='ready' WHERE id=$1 AND status='inspecting'",
        [id],
      );
    }
  });
  const chatSchema = z.object({
    project_id: uuid,
    title: z.string().min(1).max(160),
    provider: z.enum(["codex", "claude"]),
    account_id: uuid,
    model: z.string().max(100).default(""),
    effort: z.enum(["", "low", "medium", "high", "xhigh"]).default(""),
    autonomous: z.boolean().default(false),
    handoff: z.enum(["manual", "auto"]).default("manual"),
  });
  app.post("/api/chats", async (req) => {
    const c = chatSchema.parse(req.body);
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
    return (
      await db.query(
        "INSERT INTO chats(id,project_id,title,provider,account_id,model,effort,autonomous,handoff,branch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          id,
          c.project_id,
          c.title,
          c.provider,
          c.account_id,
          c.model,
          c.effort,
          c.autonomous,
          c.handoff,
          "workspace/" + id.slice(0, 8),
        ],
      )
    ).rows[0];
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
          "SELECT * FROM (SELECT * FROM events WHERE chat_id=$1 AND type IN ('handoff','tool','log') ORDER BY id DESC LIMIT 100) e ORDER BY id",
          [id],
        )
      ).rows,
    };
  });
  app.patch("/api/chats/:id", async (req) => {
    const id = idOf(req);
    await idle(id);
    const p = z
      .object({
        title: z.string().min(1).max(160),
        model: z.string().max(100),
        effort: z.enum(["", "low", "medium", "high", "xhigh"]),
        autonomous: z.boolean(),
        handoff: z.enum(["manual", "auto"]),
      })
      .parse(req.body);
    if (p.handoff === "auto" && !config.autoHandoff)
      throw Object.assign(new Error("Automatic handoff disabled"), {
        statusCode: 400,
      });
    await db.query(
      "UPDATE chats SET title=$2,model=$3,effort=$4,autonomous=$5,handoff=$6 WHERE id=$1",
      [id, p.title, p.model, p.effort, p.autonomous, p.handoff],
    );
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
      await c.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [id]);
      const previous = (
        await c.query(
          "SELECT id FROM messages WHERE chat_id=$1 AND client_id=$2",
          [id, p.client_id],
        )
      ).rows[0];
      if (previous) return previous;
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
    await db.query(
      "UPDATE jobs SET cancel_requested=true WHERE chat_id=$1 AND state IN ('running','waiting_approval')",
      [id],
    );
    for (const j of (
      await db.query(
        "SELECT id FROM jobs WHERE chat_id=$1 AND state IN ('running','waiting_approval')",
        [id],
      )
    ).rows) {
      active.get(j.id)?.send({ type: "stop" });
      setTimeout(() => {
        void active.get(j.id)?.stop();
      }, 10000);
    }
    await db.query(
      "UPDATE jobs SET state='cancelled' WHERE chat_id=$1 AND state IN ('queued','waiting_account')",
      [id],
    );
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
    await transaction(async (c) => {
      const a = (
        await c.query(
          "SELECT * FROM approvals WHERE id=$1 AND decision IS NULL FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!a || !active.has(a.job_id))
        throw Object.assign(new Error("This request is no longer active"), {
          statusCode: 409,
        });
      await c.query("UPDATE approvals SET decision=$2 WHERE id=$1", [
        id,
        allow,
      ]);
      active.get(a.job_id)!.send({ type: "approve", id: a.request_id, allow });
      await c.query("UPDATE jobs SET state='running' WHERE id=$1", [a.job_id]);
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
            "INSERT INTO attachments(id,chat_id,name,mime,size,storage_name,client_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
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
        "DELETE FROM attachments WHERE id=$1 AND message_id IS NULL RETURNING *",
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
    const p = z
      .string()
      .min(1)
      .max(1000)
      .parse((req.query as any).path);
    const data = await inspectWorkspace(id, p, "file");
    reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(p)),
      )
      .type("application/octet-stream");
    return reply.send(data);
  });
  app.get("/api/chats/:id/diff", async (req) => ({
    diff: await git(workspace(idOf(req)), [
      "diff",
      "HEAD",
      "--",
      ".",
      ":!.workspace-attachments",
    ]),
  }));
  app.post("/api/chats/:id/git", async (req) => {
    const id = idOf(req);
    await idle(id);
    if (terminals.has(id))
      throw Object.assign(new Error("Close the terminal before publishing"), {
        statusCode: 409,
      });
    const chat = await chatBy(id),
      p = z
        .object({
          action: z.enum(["commit", "push", "pr"]),
          message: z.string().min(1).max(500),
          client_id: uuid,
        })
        .parse(req.body);
    const previous = (
      await db.query("SELECT * FROM publications WHERE id=$1", [p.client_id])
    ).rows[0];
    if (previous) return previous;
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
      let result: any = {};
      if (p.action === "commit") {
        await git(workspace(id), ["add", "--all", "--", "."]);
        await git(workspace(id), [
          "reset",
          "--",
          ".workspace-attachments",
        ]).catch(() => {});
        result.output = await git(workspace(id), ["commit", "-m", p.message]);
      } else if (p.action === "push") {
        result.output = await pushBranch(chat, project);
      } else {
        const existing = await github(
          "/repos/" +
            project.repo +
            "/pulls?head=" +
            encodeURIComponent(project.repo.split("/")[0] + ":" + chat.branch) +
            "&state=open",
        );
        result =
          existing[0] ||
          (await github("/repos/" + project.repo + "/pulls", "POST", {
            title: p.message,
            head: chat.branch,
            base: project.base_branch,
            body: "Created with AI Workspace.",
          }));
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
    if (req.headers.origin !== config.origin) {
      socket.close(1008);
      return;
    }
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
      if (e.chat_id === chatId && socket.readyState === 1)
        socket.send(JSON.stringify(e));
    };
    const listener = (e: any) => (buffering ? buffer.push(e) : send(e));
    bus.on("event", listener);
    socket.on("close", () => bus.off("event", listener));
    void (async () => {
      try {
        let cursor = after;
        while (socket.readyState === 1) {
          const rows = (
            await db.query(
              "SELECT * FROM events WHERE chat_id=$1 AND id>$2 ORDER BY id LIMIT 500",
              [chatId, cursor],
            )
          ).rows;
          for (const e of rows) send(e);
          if (rows.length) cursor = rows.at(-1).id;
          if (rows.length < 500) break;
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
    if (req.headers.origin !== config.origin) {
      socket.close(1008);
      return;
    }
    const authTimer = setInterval(() => {
      void authenticated(req.cookies.session)
        .then((ok) => {
          if (!ok) socket.close(1008);
        })
        .catch(() => socket.close(1011));
    }, 60000);
    socket.on("close", () => clearInterval(authTimer));
    let runtime: Running | undefined,
      closed = false,
      leased = false;
    void (async () => {
      try {
        const chat = await chatBy(id);
        await idle(id);
        if (terminals.has(id)) throw new Error("Terminal already open");
        await acquireWorkspace(id, "terminal");
        leased = true;
        if (closed) {
          await releaseWorkspace(id);
          leased = false;
          return;
        }
        await initializeWorkspace(chat);
        runtime = await launch(id, null, (e) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(e));
        });
        if (closed) {
          await runtime.stop();
          await releaseWorkspace(id);
          leased = false;
          return;
        }
        terminals.set(id, runtime);
        runtime.send({ type: "terminal", data: "" });
      } catch (e: any) {
        if (leased) {
          await releaseWorkspace(id);
          leased = false;
        }
        if (socket.readyState !== 1) return;
        socket.send(
          JSON.stringify({
            type: "terminal",
            data: "\r\n" + e.message + "\r\n",
          }),
        );
        socket.close();
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
    socket.on("close", () => {
      closed = true;
      terminals.delete(id);
      void (async () => {
        await runtime?.stop();
        if (leased && runtime) {
          await releaseWorkspace(id);
          leased = false;
        }
      })();
    });
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
    for (const r of terminals.values()) await r.stop();
  });
  return app;
}
