import { randomUUID } from "node:crypto";
import { mkdir, chown, rename } from "node:fs/promises";
import path from "node:path";
import { db, transaction } from "./db.js";
import {
  createWorkspace,
  workspaceBy,
  workspacePath,
  workspaceGitPath,
  validateWorktree,
} from "./workspaces.js";
import { acquireFolders, releaseFolder } from "./leases.js";
import { folderHelper, operationPath } from "./folder-operations.js";
import { modelDefaults } from "./settings.js";
const fail = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 409 });
};
export async function resolveWithAgent(
  id: string,
  reviewId: string,
  accountId: string,
) {
  const source = await workspaceBy(id);
  if (
    source.kind !== "copy" ||
    !source.source_workspace_id ||
    source.resolution_source_id
  )
    fail("Choose a regular working copy to start conflict resolution.");
  const mainId = source.source_workspace_id!;
  await acquireFolders([id, mainId], "preparing conflict resolution");
  const op = randomUUID(),
    resolutionId = randomUUID(),
    chatId = randomUUID(),
    messageId = randomUUID();
  try {
    await validateWorktree(source);
    const review = (
      await db.query(
        "SELECT * FROM workspace_operations WHERE id=$1 AND workspace_id=$2 AND kind='review'",
        [reviewId, id],
      )
    ).rows[0];
    if (
      !review ||
      review.status !== "reviewed" ||
      review.base_snapshot_id !== (await workspaceBy(id)).base_snapshot_id
    )
      fail("Refresh the review before resolving conflicts.");
    if (!review.result.changes.some((c: any) => c.conflict))
      fail("There are no conflicts to resolve.");
    const account = (
      await db.query(
        "SELECT * FROM accounts WHERE id=$1 AND status IN ('ready','limited')",
        [accountId],
      )
    ).rows[0];
    if (!account) fail("Choose a connected agent account.");
    const defaults = (await modelDefaults())[
      account.provider as "codex" | "claude"
    ];
    const w = await transaction(async (c) => {
      const w = await createWorkspace(
        source.project_id,
        "copy",
        ("Resolve · " + source.name).slice(0, 80),
        c,
        resolutionId,
      );
      await c.query(
        "INSERT INTO workspace_operations(id,kind,workspace_id,main_workspace_id,status) VALUES($1,'resolve',$2,$3,'preparing')",
        [op, resolutionId, mainId],
      );
      await c.query(
        "UPDATE workspaces SET status='preparing',source_workspace_id=$2,resolution_source_id=$3,resolution_review_id=$4,resolution_operation_id=$5 WHERE id=$1",
        [resolutionId, mainId, id, reviewId, op],
      );
      await c.query(
        "UPDATE workspace_operations SET status='resolving' WHERE id=$1",
        [reviewId],
      );
      return w;
    });
    await mkdir(workspaceGitPath(mainId), { recursive: true, mode: 0o700 });
    if (process.getuid?.() === 0)
      await chown(workspaceGitPath(mainId), 1000, 1000);
    const result = await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417029,hashtext($1))", [
        mainId,
      ]);
      return folderHelper(
        "resolve",
        op,
        {
          source: workspacePath(id),
          main: workspacePath(mainId),
          base: operationPath(review.base_snapshot_id),
          review: operationPath(reviewId),
        },
        { ...review.result, id: resolutionId, mainId, branch: w.branch },
        { ["workspace-git/" + mainId]: workspaceGitPath(mainId) },
      );
    });
    await rename(
      path.join(operationPath(op), "prepared"),
      workspacePath(resolutionId),
    );
    const prompt =
      "Resolve the conflicts between this working copy and the main folder. Combine the intent of both versions, check the result, and explain your decisions. Keep the originals unchanged so I can review the result before transferring it.";
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      if (
        !(
          await c.query(
            "SELECT id FROM accounts WHERE id=$1 AND status IN ('ready','limited')",
            [accountId],
          )
        ).rowCount
      )
        fail(
          "The selected account is no longer available. The prepared resolution folder has been kept.",
        );
      await c.query(
        "UPDATE workspaces SET status='ready',initialized=true,storage_mode=$2,git_source_id=$3,base_snapshot_id=$4,copy_exclusions=$5 WHERE id=$1",
        [
          resolutionId,
          result.storageMode,
          result.storageMode === "worktree" ? mainId : null,
          op,
          JSON.stringify(result.excluded),
        ],
      );
      await c.query(
        "UPDATE workspace_operations SET status='completed',result=$2 WHERE id=$1",
        [op, JSON.stringify(result)],
      );
      await c.query(
        "INSERT INTO chats(id,project_id,workspace_id,title,provider,account_id,model,effort,branch,initialized) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)",
        [
          chatId,
          source.project_id,
          resolutionId,
          w.name,
          account.provider,
          accountId,
          defaults?.model || "",
          defaults?.effort || "",
          w.branch,
        ],
      );
      await c.query(
        "INSERT INTO messages(id,chat_id,role,content) VALUES($1,$2,'user',$3)",
        [messageId, chatId, prompt],
      );
      await c.query(
        "INSERT INTO jobs(id,chat_id,message_id) VALUES($1,$2,$3)",
        [randomUUID(), chatId, messageId],
      );
    });
    return { chat_id: chatId, workspace_id: resolutionId };
  } catch (e) {
    await db.query(
      "UPDATE workspaces SET status='failed' WHERE id=$1 AND status='preparing'",
      [resolutionId],
    );
    await db.query(
      "UPDATE workspace_operations SET status='failed' WHERE id=$1 AND status='preparing'",
      [op],
    );
    throw e;
  } finally {
    await releaseFolder(id);
    await releaseFolder(mainId);
  }
}
