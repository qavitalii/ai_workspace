import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type pg from "pg";
import { config } from "./config.js";
import { db } from "./db.js";

type Connection = Pick<pg.PoolClient, "query">;
export type Workspace = {
  id: string;
  project_id: string | null;
  name: string;
  kind: "main" | "saved" | "personal" | "copy";
  status: string;
  storage_mode: "legacy" | "folder" | "worktree";
  git_source_id: string | null;
  resolution_review_id: string | null;
  resolution_operation_id: string | null;
  resolution_source_id: string | null;
  source_workspace_id: string | null;
  base_snapshot_id: string | null;
  branch: string;
  initialized: boolean;
};
export const workspacePath = (id: string) =>
  path.join(config.data, "workspaces", id);
export async function workspaceBy(
  id: string,
  c: Connection = db,
): Promise<Workspace> {
  const row = (await c.query("SELECT * FROM workspaces WHERE id=$1", [id]))
    .rows[0];
  if (!row)
    throw Object.assign(new Error("Working folder not found"), {
      statusCode: 404,
    });
  return row;
}
export async function chatWorkspace(
  chatId: string,
  c: Connection = db,
): Promise<Workspace> {
  const row = (
    await c.query(
      "SELECT w.* FROM workspaces w JOIN chats c ON c.workspace_id=w.id WHERE c.id=$1",
      [chatId],
    )
  ).rows[0];
  if (!row)
    throw Object.assign(new Error("Chat not found"), { statusCode: 404 });
  return row;
}
export async function createWorkspace(
  projectId: string | null,
  kind: Workspace["kind"],
  name: string,
  c: Connection,
  id: string = randomUUID(),
): Promise<Workspace> {
  return (
    await c.query(
      "INSERT INTO workspaces(id,project_id,name,kind,branch) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [id, projectId, name, kind, "workspace/" + id],
    )
  ).rows[0];
}
// Caller holds the scheduler lock. An existing project's main folder is chosen
// explicitly; old chat folders are never silently combined or replaced.
export async function mainWorkspace(
  projectId: string,
  c: Connection,
): Promise<Workspace> {
  if (
    !(
      await c.query("SELECT id FROM projects WHERE id=$1 FOR UPDATE", [
        projectId,
      ])
    ).rowCount
  )
    throw Object.assign(new Error("Project not found"), { statusCode: 404 });
  const rows = (
    await c.query("SELECT * FROM workspaces WHERE project_id=$1", [projectId])
  ).rows;
  const main = rows.find((w) => w.kind === "main");
  if (main) return main;
  if (rows.length)
    throw Object.assign(
      new Error(
        "Choose this project's main folder in Project settings first. All existing folders are preserved.",
      ),
      { statusCode: 409 },
    );
  return createWorkspace(projectId, "main", "Main folder", c);
}
export async function workspaceBusy(
  id: string,
  c: Connection = db,
  includeQueued = false,
) {
  return (
    await c.query(
      `
    SELECT name AS title,status AS kind FROM workspaces WHERE id=$1 AND status NOT IN ('ready','failed')
    UNION ALL
    SELECT c.title, 'task' AS kind FROM jobs j JOIN chats c ON c.id=j.chat_id
    WHERE c.workspace_id=$1 AND j.state=ANY($2::text[])
    UNION ALL
    SELECT COALESCE(c.title, 'Folder operation'), l.kind FROM workspace_leases l
    LEFT JOIN chats c ON c.id=l.chat_id WHERE l.workspace_id=$1 LIMIT 1`,
      [
        id,
        includeQueued
          ? ["queued", "running", "waiting_approval", "waiting_account"]
          : ["running", "waiting_approval"],
      ],
    )
  ).rows[0];
}

export const workspaceGitPath = (id: string) =>
  path.join(config.data, "workspace-git", id);
export function workspaceGitMounts(w: Workspace, write = false) {
  return w.git_source_id
    ? [
        {
          Type: "bind" as const,
          Source: workspaceGitPath(w.git_source_id),
          Target: "/workspace-git/" + w.git_source_id,
          ReadOnly: !write,
        },
      ]
    : [];
}

// Agent sessions can edit the Git file, but trusted Git writes must never be
// redirected into another copy's shared metadata.
export async function validateWorktree(w: Workspace) {
  if (!w.git_source_id) return;
  let file;
  try {
    file = await open(
      path.join(workspacePath(w.id), ".git"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024) throw Error();
    // Bound the descriptor read too: the leaf can grow after stat().
    const bytes = Buffer.alloc(1025);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 1024) throw Error();
    const pointer = bytes.subarray(0, length).toString("utf8");
    if (
      pointer !==
      `gitdir: /workspace-git/${w.git_source_id}/worktrees/${w.id}\n`
    )
      throw Error();
  } catch {
    throw Object.assign(
      new Error(
        "This working copy's Git link has changed. Restore its original .git file before using Git actions.",
      ),
      { statusCode: 409 },
    );
  } finally {
    await file?.close();
  }
}
