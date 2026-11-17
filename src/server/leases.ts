import { foldersBusy } from "./folders.js";
import { db, transaction } from "./db.js";
import { chatWorkspace, workspaceBy, workspaceBusy } from "./workspaces.js";

export async function acquireFolder(
  workspaceId: string,
  kind: string,
  chatId: string | null = null,
) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const w = await workspaceBy(workspaceId, c);
    if (w.status !== "ready")
      throw Object.assign(new Error("This folder is not ready."), {
        statusCode: 409,
      });
    const busy = await workspaceBusy(workspaceId, c, true);
    if (busy)
      throw Object.assign(
        new Error(
          `This folder is in use by ${busy.title}. Wait for the task or close its terminal first.`,
        ),
        { statusCode: 409 },
      );
    if (chatId && (await foldersBusy(chatId, c)))
      throw Object.assign(
        new Error("A connected folder is in use by another chat"),
        { statusCode: 409 },
      );
    await c.query(
      "INSERT INTO workspace_leases(workspace_id,chat_id,kind) VALUES($1,$2,$3)",
      [workspaceId, chatId, kind],
    );
  });
}
export async function acquireWorkspace(chatId: string, kind: string) {
  const w = await chatWorkspace(chatId);
  await acquireFolder(w.id, kind, chatId);
}
export async function releaseWorkspace(chatId: string) {
  await db.query("DELETE FROM workspace_leases WHERE chat_id=$1", [chatId]);
}
export async function releaseFolder(workspaceId: string) {
  await db.query(
    "DELETE FROM workspace_leases WHERE workspace_id=$1 AND chat_id IS NULL",
    [workspaceId],
  );
}

export async function acquireFolders(ids: string[], kind: string) {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    for (const id of [...new Set(ids)].sort()) {
      const w = await workspaceBy(id, c);
      if (w.status !== "ready")
        throw Object.assign(
          new Error(
            `${w.name} is not ready. Wait for its current operation to finish.`,
          ),
          { statusCode: 409 },
        );
      const busy = await workspaceBusy(id, c, true);
      if (busy)
        throw Object.assign(
          new Error(
            `${w.name} is in use by ${busy.title}. Stop queued tasks or close its terminal before continuing.`,
          ),
          { statusCode: 409 },
        );
      await c.query(
        "INSERT INTO workspace_leases(workspace_id,kind) VALUES($1,$2)",
        [id, kind],
      );
    }
  });
}
