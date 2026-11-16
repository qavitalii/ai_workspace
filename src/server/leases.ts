import { foldersBusy } from "./folders.js";
import { db, transaction } from "./db.js";
export async function acquireWorkspace(chatId: string, kind: string) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    if (
      (
        await c.query(
          "SELECT 1 FROM jobs WHERE chat_id=$1 AND state IN ('queued','running','waiting_approval')",
          [chatId],
        )
      ).rowCount
    )
      throw Object.assign(new Error("Stop the current task first"), {
        statusCode: 409,
      });
    if (await foldersBusy(chatId, c))
      throw Object.assign(
        new Error("A connected folder is in use by another chat"),
        { statusCode: 409 },
      );
    await c.query("INSERT INTO workspace_leases(chat_id,kind) VALUES($1,$2)", [
      chatId,
      kind,
    ]);
  });
}
export async function releaseWorkspace(chatId: string) {
  await db.query("DELETE FROM workspace_leases WHERE chat_id=$1", [chatId]);
}
