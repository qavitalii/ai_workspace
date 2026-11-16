import { mkdir, readdir, lstat, realpath, chown } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { db } from "./db.js";
import { config } from "./config.js";

export const folderRoot = () =>
  path.resolve(config.folderRoot || path.join(config.data, "shared"));
export function folderName(name: string) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) ||
    name === "." ||
    name === ".."
  )
    throw Object.assign(
      new Error(
        "Use a folder name with letters, numbers, dots, dashes or underscores (up to 80 characters).",
      ),
      { statusCode: 400 },
    );
  return name;
}
export async function folderPath(name: string) {
  const root = await realpath(folderRoot());
  const target = path.join(root, folderName(name));
  const stat = await lstat(target).catch(() => null);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(target)) !== target
  )
    throw Object.assign(new Error("Folder not found or is a symbolic link"), {
      statusCode: 400,
    });
  return target;
}
export async function availableFolders() {
  await mkdir(folderRoot(), { recursive: true, mode: 0o700 });
  return (await readdir(folderRoot(), { withFileTypes: true }))
    .filter(
      (f) =>
        f.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(f.name),
    )
    .map((f) => f.name)
    .sort();
}
export async function createFolder(name: string) {
  await availableFolders();
  const target = path.join(folderRoot(), folderName(name));
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (e: any) {
    if (e.code === "EEXIST")
      throw Object.assign(new Error("A folder with this name already exists"), {
        statusCode: 409,
      });
    throw e;
  }
  if (process.getuid?.() === 0) await chown(target, 1000, 1000);
}
export async function chatFolders(
  chatId: string,
  query: Pick<pg.PoolClient, "query"> = db,
) {
  return (
    await query.query(
      "SELECT f.* FROM folder_links f JOIN chats c ON c.id=$1 WHERE f.chat_id=c.id OR f.project_id=c.project_id ORDER BY f.name",
      [chatId],
    )
  ).rows;
}
export async function folderMounts(chatId: string) {
  const rows = await chatFolders(chatId);
  const grouped = new Map<string, boolean>();
  for (const r of rows)
    grouped.set(r.name, (grouped.get(r.name) ?? true) && r.read_only);
  return Promise.all(
    [...grouped].map(async ([name, readOnly]) => ({
      Type: "bind" as const,
      Source: await folderPath(name),
      Target: "/workspace/.workspace-folders/" + name,
      ReadOnly: readOnly,
    })),
  );
}
/** Called under the queue lock. Any shared writer excludes other readers/writers. */
export async function foldersBusy(
  chatId: string,
  query: Pick<pg.PoolClient, "query"> = db,
) {
  return !!(
    await query.query(
      `SELECT 1 FROM folder_links mine JOIN chats c ON c.id=$1
    JOIN folder_links other ON other.name=mine.name
    JOIN chats o ON other.chat_id=o.id OR other.project_id=o.project_id
    WHERE (mine.chat_id=c.id OR mine.project_id=c.project_id) AND o.id<>c.id
    AND (NOT mine.read_only OR NOT other.read_only)
    AND (EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=o.id AND j.state IN ('running','waiting_approval'))
      OR EXISTS(SELECT 1 FROM workspace_leases w WHERE w.chat_id=o.id)) LIMIT 1`,
      [chatId],
    )
  ).rowCount;
}
export async function requireFolderIdle(
  name: string,
  query: Pick<pg.PoolClient, "query">,
) {
  if (
    (
      await query.query(
        `SELECT 1 FROM folder_links f JOIN chats c ON f.chat_id=c.id OR f.project_id=c.project_id
    WHERE f.name=$1 AND (EXISTS(SELECT 1 FROM jobs j WHERE j.chat_id=c.id AND j.state IN ('running','waiting_approval')) OR EXISTS(SELECT 1 FROM workspace_leases w WHERE w.chat_id=c.id)) LIMIT 1`,
        [name],
      )
    ).rowCount
  )
    throw Object.assign(
      new Error("Stop tasks and close terminals using this folder first"),
      { statusCode: 409 },
    );
}
