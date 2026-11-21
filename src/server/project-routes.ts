import { resolveWithAgent } from "./conflict-resolution.js";
import {
  createCopy,
  reviewCopy,
  applyCopy,
  deletionInfo,
  deleteWorkingFolder,
} from "./folder-operations.js";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink, access } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { acquireFolder, releaseFolder } from "./leases.js";
import { initializeFolder } from "./git.js";
import { syncFromGithub } from "./github-sync.js";
import { inspectDirectory } from "./files.js";
import {
  addProjectPackage,
  listProjectPackages,
  removeProjectPackages,
  setAutoPackages,
} from "./project-packages.js";
import { packageNames } from "../runner/package-request.js";
import { uploadPath, copyFolderUpload } from "./folder-routes.js";
import {
  workspaceBy,
  workspacePath,
  workspaceBusy,
  createWorkspace,
} from "./workspaces.js";

export function workspaceUploadPath(input: string) {
  const relative = uploadPath(input);
  if (relative.split("/").some((part) => part.startsWith(".workspace-")))
    throw Object.assign(
      new Error("Choose a path outside the app's internal folders."),
      { statusCode: 400 },
    );
  return relative;
}

const projectParams = z.object({ id: z.uuid() });
const packageName = z.string().refine((name) => packageNames([name]) !== null);

export function projectRoutes(app: FastifyInstance) {
  app.get("/api/projects/:id/packages", async (req) =>
    listProjectPackages(projectParams.parse(req.params).id),
  );
  app.post("/api/projects/:id/packages", async (req) => {
    const { name } = z.object({ name: packageName }).parse(req.body);
    return addProjectPackage(projectParams.parse(req.params).id, name);
  });
  app.patch("/api/projects/:id/packages", async (req) => {
    const { auto_packages } = z
      .object({ auto_packages: z.boolean() })
      .parse(req.body);
    return setAutoPackages(projectParams.parse(req.params).id, auto_packages);
  });
  app.delete("/api/projects/:id/packages/:name", async (req) => {
    const { id, name } = projectParams
      .extend({ name: packageName })
      .parse(req.params);
    return removeProjectPackages(id, { name });
  });
  app.delete("/api/projects/:id/packages/requests/:requestId", async (req) => {
    const { id, requestId } = projectParams
      .extend({ requestId: z.uuid() })
      .parse(req.params);
    return removeProjectPackages(id, { requestId });
  });
  app.post("/api/workspaces/:id/copies", async (req) =>
    createCopy(
      z.uuid().parse((req.params as any).id),
      z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body).name,
    ),
  );
  app.post("/api/workspaces/:id/review", async (req) =>
    reviewCopy(z.uuid().parse((req.params as any).id)),
  );
  app.post("/api/workspaces/:id/resolve", async (req) => {
    const body = z
      .object({ review_id: z.uuid(), account_id: z.uuid() })
      .parse(req.body);
    return resolveWithAgent(
      z.uuid().parse((req.params as any).id),
      body.review_id,
      body.account_id,
    );
  });
  app.post("/api/workspaces/:id/apply", async (req) => {
    const body = z
      .object({
        review_id: z.uuid(),
        choices: z.record(z.string(), z.enum(["main", "copy"])),
      })
      .parse(req.body);
    return applyCopy(
      z.uuid().parse((req.params as any).id),
      body.review_id,
      body.choices,
    );
  });
  app.get("/api/workspaces/:id/deletion", async (req) =>
    deletionInfo(z.uuid().parse((req.params as any).id)),
  );
  app.delete("/api/workspaces/:id", async (req) =>
    deleteWorkingFolder(
      z.uuid().parse((req.params as any).id),
      z.object({ name: z.string() }).parse(req.body).name,
    ),
  );

  app.get("/api/projects/:id/workspaces", async (req) => {
    const id = z.uuid().parse((req.params as any).id);
    if (!(await db.query("SELECT id FROM projects WHERE id=$1", [id])).rowCount)
      throw Object.assign(new Error("Project not found"), { statusCode: 404 });
    return (
      await db.query(
        "SELECT * FROM workspaces WHERE project_id=$1 ORDER BY (kind='main') DESC,created_at",
        [id],
      )
    ).rows;
  });
  app.post("/api/projects/:id/main-workspace", async (req) => {
    const id = z.uuid().parse((req.params as any).id);
    const { workspace_id } = z
      .object({ workspace_id: z.uuid().nullable() })
      .parse(req.body);
    return transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(await c.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [id]))
          .rowCount
      )
        throw Object.assign(new Error("Project not found"), {
          statusCode: 404,
        });
      if (
        (
          await c.query(
            "SELECT 1 FROM workspaces WHERE project_id=$1 AND kind='main'",
            [id],
          )
        ).rowCount
      )
        throw Object.assign(
          new Error("This project already has a main folder."),
          { statusCode: 409 },
        );
      if (workspace_id === null)
        return createWorkspace(id, "main", "Main folder", c);
      const w = await workspaceBy(workspace_id, c);
      if (w.project_id !== id || w.kind !== "saved")
        throw Object.assign(new Error("Choose a folder from this project."), {
          statusCode: 400,
        });
      if (await workspaceBusy(w.id, c, true))
        throw Object.assign(
          new Error("Stop tasks and close terminals using this folder first."),
          { statusCode: 409 },
        );
      return (
        await c.query(
          "UPDATE workspaces SET kind='main',name='Main folder' WHERE id=$1 RETURNING *",
          [w.id],
        )
      ).rows[0];
    });
  });
  app.post("/api/workspaces/:id/initialize", async (req) => {
    const w = await workspaceBy(z.uuid().parse((req.params as any).id));
    await acquireFolder(w.id, "initialization");
    try {
      await initializeFolder(w);
      return await workspaceBy(w.id);
    } finally {
      await releaseFolder(w.id);
    }
  });
  app.post("/api/workspaces/:id/sync", async (req) => {
    const id = z.uuid().parse((req.params as any).id);
    await acquireFolder(id, "GitHub sync");
    try {
      return await syncFromGithub(id);
    } finally {
      await releaseFolder(id);
    }
  });
  app.get("/api/workspaces/:id/files", async (req) => {
    const w = await workspaceBy(z.uuid().parse((req.params as any).id));
    try {
      await access(workspacePath(w.id));
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
    return inspectDirectory(
      workspacePath(w.id),
      String((req.query as any).path || ""),
      "list",
    );
  });
  app.get("/api/workspaces/:id/file", async (req, reply) => {
    const w = await workspaceBy(z.uuid().parse((req.params as any).id));
    const relative = uploadPath(String((req.query as any).path || ""));
    const buffer = await inspectDirectory(
      workspacePath(w.id),
      relative,
      "file",
    );
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Disposition",
        "attachment; filename*=UTF-8''" +
          encodeURIComponent(path.basename(relative)),
      )
      .type("application/octet-stream")
      .send(buffer);
  });
  app.get("/api/workspaces/:id/attachments", async (req) => {
    const w = await workspaceBy(z.uuid().parse((req.params as any).id));
    return (
      await db.query(
        "SELECT a.id,a.name,a.size,a.created_at,c.title AS chat_title FROM attachments a LEFT JOIN chats c ON c.id=a.chat_id WHERE a.workspace_id=$1 AND (a.message_id IS NOT NULL OR a.chat_id IS NULL) ORDER BY a.created_at DESC",
        [w.id],
      )
    ).rows;
  });
  app.post(
    "/api/workspaces/:id/attachments/:attachmentId/save",
    async (req) => {
      const w = await workspaceBy(z.uuid().parse((req.params as any).id));
      const attachmentId = z.uuid().parse((req.params as any).attachmentId);
      const relative = workspaceUploadPath(
        z.object({ path: z.string() }).parse(req.body).path,
      );
      await acquireFolder(w.id, "upload");
      try {
        const file = (
          await db.query(
            "SELECT storage_name FROM attachments WHERE id=$1 AND workspace_id=$2 AND (message_id IS NOT NULL OR chat_id IS NULL)",
            [attachmentId, w.id],
          )
        ).rows[0];
        if (!file)
          throw Object.assign(new Error("Saved attachment not found"), {
            statusCode: 404,
          });
        await initializeFolder(w);
        await copyFolderUpload(
          workspacePath(w.id),
          path.join(config.data, "uploads", file.storage_name),
          relative,
        );
        return { ok: true };
      } finally {
        await releaseFolder(w.id);
      }
    },
  );
  app.post("/api/workspaces/:id/files", async (req) => {
    const w = await workspaceBy(z.uuid().parse((req.params as any).id));
    const relative = workspaceUploadPath(String((req.query as any).path || ""));
    const part = await req.file();
    if (!part)
      throw Object.assign(new Error("Choose a file"), { statusCode: 400 });
    const dir = path.join(config.data, "folder-uploads");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const staged = path.join(dir, randomUUID());
    try {
      await pipeline(
        part.file,
        createWriteStream(staged, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated)
        throw Object.assign(new Error("File is too large"), {
          statusCode: 413,
        });
      await acquireFolder(w.id, "upload");
      try {
        await initializeFolder(w);
        await copyFolderUpload(workspacePath(w.id), staged, relative);
        return { ok: true };
      } finally {
        await releaseFolder(w.id);
      }
    } finally {
      await unlink(staged).catch(() => {});
    }
  });
}
