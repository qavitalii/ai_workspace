import { db, transaction } from "./db.js";
import { launch, type Running } from "./runtime.js";

export async function disconnectAccount(id: string, start = launch) {
  const account = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const account = (
      await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!account)
      throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    if (
      [
        "authenticating",
        "inspecting",
        "disconnecting",
        "deleting",
        "delete_failed",
      ].includes(account.status)
    )
      throw Object.assign(
        new Error("Wait for the current account operation to finish"),
        { statusCode: 409 },
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM jobs WHERE account_id=$1 AND state IN ('running','waiting_approval')",
          [id],
        )
      ).rowCount
    )
      throw Object.assign(
        new Error("Stop the active task before disconnecting this account"),
        { statusCode: 409 },
      );
    await c.query(
      "UPDATE accounts SET status='disconnecting',model_catalog=NULL,models_updated_at=NULL WHERE id=$1",
      [id],
    );
    return account;
  });
  let runtime: Running | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let success = false;
  try {
    let resolve!: () => void, reject!: (error: Error) => void;
    const completed = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Attach a rejection handler before container creation can emit an early failure.
    void completed.catch(() => {});
    runtime = await start(null, id, (e) => {
      if (e.type === "logout_complete") {
        if (e.success) resolve();
        else
          reject(
            new Error("The agent could not sign out. Try Disconnect again."),
          );
      }
      if (["failed", "exit"].includes(e.type))
        reject(new Error("The agent stopped before confirming sign-out"));
    });
    timer = setTimeout(
      () => reject(new Error("Sign-out timed out. Try Disconnect again.")),
      30000,
    );
    runtime.send({ type: "logout", provider: account.provider });
    await completed;
    success = true;
  } finally {
    clearTimeout(timer);
    await runtime?.stop();
    // Never schedule work with credentials whose state is uncertain after a failed logout.
    await db.query(
      "UPDATE accounts SET status=$2,limits=NULL,reset_at=NULL WHERE id=$1 AND status='disconnecting'",
      [id, success ? "disconnected" : "disconnect_failed"],
    );
  }
  return { ok: true };
}

/** Local removal only: never deletes the upstream Codex/Claude account. */
export async function deleteAccount(id: string, name: string) {
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const a = (
      await c.query("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!a)
      throw Object.assign(new Error("Account not found"), { statusCode: 404 });
    if (a.name !== name)
      throw Object.assign(
        new Error("Type the account label to confirm deletion."),
        { statusCode: 400 },
      );
    if (
      ["authenticating", "inspecting", "disconnecting", "deleting"].includes(
        a.status,
      )
    )
      throw Object.assign(
        new Error("Wait for the current account operation to finish."),
        { statusCode: 409 },
      );
    if (
      (
        await c.query(
          "SELECT 1 FROM jobs j JOIN chats c ON c.id=j.chat_id WHERE (j.account_id=$1 AND j.state IN ('running','waiting_approval')) OR (c.account_id=$1 AND j.state IN ('queued','waiting_account'))",
          [id],
        )
      ).rowCount
    )
      throw Object.assign(
        new Error(
          "Stop active and queued tasks using this account before deleting it.",
        ),
        { statusCode: 409 },
      );
    await c.query("UPDATE accounts SET status='deleting' WHERE id=$1", [id]);
  });
  await finishAccountDeletion(id);
  return { ok: true };
}
async function finishAccountDeletion(id: string) {
  try {
    const { rm } = await import("node:fs/promises");
    const { default: path } = await import("node:path");
    const { config } = await import("./config.js");
    for (const dir of ["profiles", "auth-workspaces"])
      await rm(path.join(config.data, dir, id), {
        recursive: true,
        force: true,
      });
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      await c.query(
        "UPDATE chats SET session_id=NULL,session_account=NULL WHERE session_account=$1",
        [id],
      );
      await c.query("UPDATE chats SET account_id=NULL WHERE account_id=$1", [
        id,
      ]);
      await c.query("UPDATE jobs SET account_id=NULL WHERE account_id=$1", [
        id,
      ]);
      await c.query("DELETE FROM accounts WHERE id=$1 AND status='deleting'", [
        id,
      ]);
    });
  } catch (e) {
    await db.query(
      "UPDATE accounts SET status='delete_failed' WHERE id=$1 AND status='deleting'",
      [id],
    );
    throw Object.assign(
      new Error(
        "Could not finish removing local account data. Retry Delete account.",
      ),
      { statusCode: 500 },
    );
  }
}
export async function recoverAccountDeletions() {
  for (const a of (
    await db.query("SELECT id FROM accounts WHERE status='deleting'")
  ).rows)
    await finishAccountDeletion(a.id);
}
