import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, chown } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { db, transaction } from "./db.js";
import { config } from "./config.js";
import { docker } from "./runtime.js";
import { inspectDirectory } from "./files.js";
import {
  availableFolders,
  createFolder,
  folderName,
  folderPath,
  requireFolderIdle,
} from "./folders.js";

export function uploadPath(input: string) {
  if (
    !input ||
    input.length > 1000 ||
    input.startsWith("/") ||
    input.includes("\\") ||
    /[\x00-\x1f]/.test(input) ||
    input.split("/").some((x) => !x || x === "." || x === ".." || x === ".git")
  )
    throw Object.assign(new Error("Invalid file path"), { statusCode: 400 });
  return input;
}
export async function copyFolderUpload(
  source: string,
  staged: string,
  relative: string,
) {
  uploadPath(relative);
  if (process.getuid?.() === 0) await chown(staged, 1000, 1000);
  const script = `const fs=require('fs'),p=require('path'),crypto=require('crypto');const target=p.resolve('/folder',process.argv[1]);if(!target.startsWith('/folder/'))throw Error('Invalid path');fs.mkdirSync(p.dirname(target),{recursive:true});if(!fs.realpathSync(p.dirname(target)).startsWith('/folder/')&&fs.realpathSync(p.dirname(target))!='/folder')throw Error('Invalid directory');try{fs.copyFileSync('/input',target,fs.constants.COPYFILE_EXCL)}catch(e){if(e.code!=='EEXIST'||fs.lstatSync(target).isSymbolicLink()||!fs.statSync(target).isFile())throw e;const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');if(fs.statSync(target).size!==fs.statSync('/input').size||hash(target)!==hash('/input'))throw Error('File already exists');}`;
  const c = await docker.createContainer({
    Image: config.image,
    User: "1000:1000",
    Cmd: ["node", "-e", script, relative],
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: source, Target: "/folder" },
        { Type: "bind", Source: staged, Target: "/input", ReadOnly: true },
      ],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: Math.max(256 * 1024 ** 2, config.maxFile * 4),
      PidsLimit: 32,
    },
  });
  const timer = setTimeout(() => void c.kill().catch(() => {}), 60000);
  try {
    await c.start();
    if ((await c.wait()).StatusCode !== 0)
      throw Object.assign(
        new Error(
          "Upload could not be saved. Check folder permissions and whether a different file already uses this path.",
        ),
        { statusCode: 409 },
      );
  } finally {
    clearTimeout(timer);
    await c.remove({ force: true }).catch(() => {});
  }
}
export function folderRoutes(app: FastifyInstance) {
  app.get("/api/folders", async () => ({ folders: await availableFolders() }));
  app.post("/api/folders", async (req) => {
    const { name } = z.object({ name: z.string() }).parse(req.body);
    await createFolder(name);
    return { name };
  });
  for (const scope of ["chats", "projects"] as const) {
    const column = scope === "chats" ? "chat_id" : "project_id";
    app.get(`/api/${scope}/:id/folders`, async (req) => {
      const id = z.uuid().parse((req.params as any).id);
      return (
        await db.query(
          scope === "chats"
            ? "SELECT f.*,f.project_id IS NOT NULL AS inherited FROM folder_links f JOIN chats c ON c.id=$1 WHERE f.chat_id=c.id OR f.project_id=c.project_id ORDER BY name"
            : "SELECT *,false AS inherited FROM folder_links WHERE project_id=$1 ORDER BY name",
          [id],
        )
      ).rows;
    });
    app.post(`/api/${scope}/:id/folders`, async (req) => {
      const id = z.uuid().parse((req.params as any).id);
      const p = z
        .object({ name: z.string(), read_only: z.boolean().default(true) })
        .parse(req.body);
      await folderPath(p.name);
      return transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(417028)");
        await requireFolderIdle(p.name, c);
        await idleScope(c, scope, id);
        const inherited =
          scope === "chats"
            ? await c.query(
                "SELECT 1 FROM folder_links f JOIN chats ch ON ch.project_id=f.project_id WHERE ch.id=$1 AND f.name=$2",
                [id, p.name],
              )
            : await c.query(
                "SELECT 1 FROM folder_links f JOIN chats ch ON ch.id=f.chat_id WHERE ch.project_id=$1 AND f.name=$2",
                [id, p.name],
              );
        if (inherited.rowCount)
          throw Object.assign(
            new Error(
              scope === "chats"
                ? "This folder is inherited. Change it in project settings."
                : "Disconnect this folder from individual chats before connecting it to the project.",
            ),
            { statusCode: 409 },
          );
        if (
          !(await c.query(`SELECT 1 FROM ${scope} WHERE id=$1`, [id])).rowCount
        )
          throw Object.assign(new Error("Not found"), { statusCode: 404 });
        await c.query(
          `INSERT INTO folder_links(id,name,${column},read_only) VALUES($1,$2,$3,$4) ON CONFLICT (${column},name) WHERE ${column} IS NOT NULL DO UPDATE SET read_only=EXCLUDED.read_only`,
          [randomUUID(), p.name, id, p.read_only],
        );
        return { ok: true };
      });
    });
    app.delete(`/api/${scope}/:id/folders/:name`, async (req) => {
      const id = z.uuid().parse((req.params as any).id),
        name = folderName((req.params as any).name);
      return transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(417028)");
        await requireFolderIdle(name, c);
        await idleScope(c, scope, id);
        await c.query(
          `DELETE FROM folder_links WHERE ${column}=$1 AND name=$2`,
          [id, name],
        );
        return { ok: true };
      });
    });
  }
  app.get("/api/folders/:name/files", async (req) =>
    inspectDirectory(
      await folderPath((req.params as any).name),
      String((req.query as any).path || ""),
      "list",
    ),
  );
  app.get("/api/folders/:name/file", async (req, reply) => {
    const relative = uploadPath(String((req.query as any).path || ""));
    const buffer = await inspectDirectory(
      await folderPath((req.params as any).name),
      relative,
      "file",
    );
    return reply
      .header(
        "content-disposition",
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(path.basename(relative)),
      )
      .type("application/octet-stream")
      .send(buffer);
  });
  app.post("/api/folders/:name/files", async (req) => {
    const name = folderName((req.params as any).name),
      source = await folderPath(name),
      relative = uploadPath(String((req.query as any).path || ""));
    const part = await req.file();
    if (!part)
      throw Object.assign(new Error("Choose a file"), { statusCode: 400 });
    const temp = path.join(config.data, "folder-uploads");
    await mkdir(temp, { recursive: true, mode: 0o700 });
    const staged = path.join(temp, randomUUID());
    try {
      await pipeline(
        part.file,
        createWriteStream(staged, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated)
        throw Object.assign(new Error("File is too large"), {
          statusCode: 413,
        });
      return await transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(417028)");
        await requireFolderIdle(name, c);
        await copyFolderUpload(source, staged, relative);
        return { ok: true };
      });
    } finally {
      await unlink(staged).catch(() => {});
    }
  });
}
async function idleScope(
  c: import("pg").PoolClient,
  scope: string,
  id: string,
) {
  const where = scope === "chats" ? "c.id=$1" : "c.project_id=$1";
  if (
    (
      await c.query(
        `SELECT 1 FROM chats c WHERE ${where} AND (EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=c.id AND j.state IN ('running','waiting_approval')) OR EXISTS(SELECT 1 FROM workspace_leases w WHERE w.chat_id=c.id)) LIMIT 1`,
        [id],
      )
    ).rowCount
  )
    throw Object.assign(
      new Error(
        "Stop tasks and close terminals before changing connected folders",
      ),
      { statusCode: 409 },
    );
}
