import { randomUUID } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import packageInfo from "../../package.json" with { type: "json" };
import { transaction } from "./db.js";

const release = z.object({
  version: z.string().regex(/^v(?:0|[1-9]\d{0,8})(?:\.(?:0|[1-9]\d{0,8})){2}$/),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
});
const hostStatus = z.object({
  phase: z.enum(["idle", "waiting", "updating", "succeeded", "failed"]),
  heartbeat: z.number(),
  available: release.nullable(),
  target: release.nullable(),
  checkedAt: z.number().nullable(),
  checkFailed: z.boolean(),
  message: z.string().max(400).nullable(),
});
const stateFile = process.env.WORKSPACE_UPDATE_STATUS;
const requestDir = process.env.WORKSPACE_UPDATE_REQUESTS;
const route = "/api/updates";
const finishingRoutes = new Set([
  "/api/chats/:id/stop",
  "/api/approvals/:id",
  "/api/questions/:id",
  "/api/accounts/:id/auth-input",
]);

async function status() {
  if (!stateFile) return null;
  try {
    return hostStatus.parse(JSON.parse(await readFile(stateFile, "utf8")));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function online(current: NonNullable<Awaited<ReturnType<typeof status>>>) {
  return (
    Date.now() - current.heartbeat < 90_000 || current.phase === "updating"
  );
}

export async function updatePhase() {
  const current = await status();
  if (current && online(current)) return current.phase;
  return "idle";
}

async function requestExists(name = "update.json") {
  if (!requestDir) return false;
  try {
    await lstat(path.join(requestDir, name));
    return true;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

export function updateRoutes(
  app: FastifyInstance,
  hasOpenTerminal: () => boolean,
) {
  let writes = 0;
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  app.addHook("onRoute", (options) => {
    const { handler, method, url } = options;
    if (
      !stateFile ||
      !url.startsWith("/api/") ||
      url === route ||
      url === route + "/check" ||
      [method].flat().every((value) => safeMethods.has(value))
    )
      return;
    options.handler = async function (req, reply) {
      writes++;
      try {
        const phase = await updatePhase();
        const mayFinish =
          finishingRoutes.has(url) ||
          (url === "/api/accounts/:id/auth" && req.method === "DELETE") ||
          url === "/api/login" ||
          url === "/api/logout";
        if (
          !safeMethods.has(req.method) &&
          (phase === "updating" || (phase === "waiting" && !mayFinish))
        )
          return reply.code(503).send({
            error:
              "Workspace is preparing an update. Try again after it restarts.",
          });
        return await handler.call(this, req, reply);
      } finally {
        writes--;
      }
    };
  });

  app.get(route, async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const current = await status();
    const pending = await requestExists();
    return {
      installed: "v" + packageInfo.version,
      updater: !current ? "disabled" : online(current) ? "ready" : "offline",
      phase:
        pending && current?.phase !== "updating"
          ? "waiting"
          : (current?.phase ?? "idle"),
      available: current?.available ?? null,
      target: current?.target ?? null,
      checkedAt: current?.checkedAt ?? null,
      checkFailed: current?.checkFailed ?? false,
      checking: await requestExists("check"),
      message:
        pending && current?.phase !== "updating"
          ? null
          : (current?.message ?? null),
    };
  });

  app.post(route, async (req, reply) => {
    const request = release.safeParse(req.body);
    if (!request.success)
      return reply.code(400).send({ error: "Invalid release selection." });
    const selected = request.data;
    const current = await status();
    if (!requestDir || !current || !online(current))
      return reply
        .code(503)
        .send({ error: "The host updater is unavailable." });
    if (current.phase === "waiting" || current.phase === "updating")
      return reply
        .code(409)
        .send({ error: "An update is already in progress." });
    if (
      current.checkFailed ||
      current.available?.version !== selected.version ||
      current.available.commit !== selected.commit
    )
      return reply.code(409).send({
        error: "The available release changed. Refresh and try again.",
      });

    const temporary = path.join(requestDir, randomUUID() + ".tmp");
    await writeFile(temporary, JSON.stringify(selected), {
      flag: "wx",
      mode: 0o600,
    });
    try {
      await link(temporary, path.join(requestDir, "update.json"));
    } catch (error: any) {
      if (error.code === "EEXIST")
        return reply
          .code(409)
          .send({ error: "An update is already in progress." });
      throw error;
    } finally {
      await unlink(temporary);
    }
    return reply.code(202).send({ ok: true });
  });

  // Asks the host updater to look for a release on its next run (seconds)
  // instead of waiting for the periodic check.
  app.post(route + "/check", async (_req, reply) => {
    const current = await status();
    if (!requestDir || !current || !online(current))
      return reply
        .code(503)
        .send({ error: "The host updater is unavailable." });
    if (
      current.phase === "waiting" ||
      current.phase === "updating" ||
      (await requestExists())
    )
      return reply
        .code(409)
        .send({ error: "An update is already in progress." });
    const temporary = path.join(requestDir, randomUUID() + ".tmp");
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    try {
      await link(temporary, path.join(requestDir, "check"));
    } catch (error: any) {
      // A check is already pending; that one will answer this request too.
      if (error.code !== "EEXIST") throw error;
    } finally {
      await unlink(temporary);
    }
    return reply.code(202).send({ ok: true });
  });

  app.get("/internal/update-ready", async (req, reply) => {
    if (req.raw.socket.remoteAddress !== "127.0.0.1")
      return reply.code(404).send({ error: "Not found" });
    const phase = await updatePhase();
    if (phase !== "waiting" && phase !== "updating")
      return reply.code(409).send({ ready: false });
    const busy = await transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(417028)");
      return (
        await client.query<{ busy: boolean }>(`
          SELECT EXISTS(SELECT FROM jobs WHERE state IN ('running','waiting_approval'))
              OR EXISTS(SELECT FROM workspace_leases)
              OR EXISTS(SELECT FROM accounts WHERE status='authenticating') AS busy
        `)
      ).rows[0].busy;
    });
    return { ready: !busy && !hasOpenTerminal() && writes === 0 };
  });
}
