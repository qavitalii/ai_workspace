import path from "node:path";
import { mkdir, chown, rename, access, rm, readdir } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { db, transaction } from "./db.js";
import { docker } from "./runtime.js";
import { removeChatSessions } from "./profiles.js";
import {
  workspaceBy,
  workspacePath,
  createWorkspace,
  type Workspace,
  workspaceGitPath,
} from "./workspaces.js";
import { acquireFolders, releaseFolder } from "./leases.js";
import { initializeFolder } from "./git.js";
export const operationPath = (id: string) =>
  path.join(config.data, "workspace-operations", id);
const checkpointPath = (id: string) =>
  path.join(config.data, "workspace-checkpoints", id);
const exists = async (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
async function prepare(p: string) {
  await mkdir(p, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) await chown(p, 1000, 1000);
}
function fail(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}
export async function folderHelper(
  command: string,
  op: string,
  mounts: Record<string, string>,
  input: unknown = {},
  writeMounts: Record<string, string> = {},
): Promise<any> {
  await prepare(operationPath(op));
  const container = await docker.createContainer({
    Image: config.image,
    User: "1000:1000",
    Cmd: [
      "node",
      "/app/dist/node/server/folder-helper.js",
      command,
      JSON.stringify(input),
    ],
    AttachStdout: true,
    AttachStderr: true,
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: operationPath(op), Target: "/operation" },
        ...Object.entries(writeMounts).map(([name, source]) => ({
          Type: "bind" as const,
          Source: source,
          Target: "/" + name,
          ReadOnly: false,
        })),
        ...Object.entries(mounts).map(([name, source]) => ({
          Type: "bind" as const,
          Source: source,
          Target: "/" + name,
          ReadOnly: true,
        })),
      ],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=128m" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 768 * 1024 ** 2,
      PidsLimit: 64,
    },
  });
  const stream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    }),
    out = new PassThrough(),
    err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  const drained = finished(stream, { readable: true, writable: false });
  void drained.catch(() => {});
  let output = "",
    error = "";
  out.on("data", (b) => {
    output += b;
    if (output.length > 16e6) void container.kill().catch(() => {});
  });
  err.on("data", (b) => {
    error = (error + b).slice(-4000);
  });
  const timer = setTimeout(() => void container.kill().catch(() => {}), 180000);
  try {
    await container.start();
    const result = await container.wait();
    await drained;
    if (result.StatusCode !== 0 || output.length > 16e6)
      fail(error || "Folder operation exceeded its time or size limit.");
    return JSON.parse(output);
  } finally {
    clearTimeout(timer);
    (stream as import("node:stream").Duplex).destroy();
    await container.remove({ force: true }).catch(() => {});
  }
}
async function mainFor(w: Workspace) {
  if (w.kind !== "copy" || !w.source_workspace_id || !w.base_snapshot_id)
    fail(
      "This folder is not a working copy. Create a copy from the main folder first.",
    );
  return workspaceBy(w.source_workspace_id);
}
export async function createCopy(mainId: string, name: string) {
  await acquireFolders([mainId], "creating a copy");
  const id = randomUUID(),
    op = randomUUID();
  try {
    const main = await workspaceBy(mainId);
    if (main.kind !== "main") fail("Create copies from the main folder.");
    await initializeFolder(main);
    const w = await transaction(async (c) => {
      const w = await createWorkspace(main.project_id, "copy", name, c, id);
      await c.query(
        "UPDATE workspaces SET status='preparing',source_workspace_id=$2 WHERE id=$1",
        [id, mainId],
      );
      await c.query(
        "INSERT INTO workspace_operations(id,kind,workspace_id,main_workspace_id,status) VALUES($1,'create',$2,$3,'preparing')",
        [op, id, mainId],
      );
      return w;
    });
    await prepare(workspaceGitPath(mainId));
    const result = await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417029,hashtext($1))", [
        mainId,
      ]);
      return folderHelper(
        "create",
        op,
        { main: workspacePath(mainId) },
        { branch: w.branch, id, mainId },
        { ["workspace-git/" + mainId]: workspaceGitPath(mainId) },
      );
    });
    await rename(path.join(operationPath(op), "prepared"), workspacePath(id));
    await transaction(async (c) => {
      await c.query(
        "UPDATE workspaces SET status='ready',initialized=true,base_snapshot_id=$2,copy_exclusions=$3,storage_mode=$4,git_source_id=$5 WHERE id=$1",
        [
          id,
          op,
          JSON.stringify(result.excluded),
          result.storageMode,
          result.storageMode === "worktree" ? mainId : null,
        ],
      );
      await c.query(
        "UPDATE workspace_operations SET status='completed' WHERE id=$1",
        [op],
      );
    });
    return workspaceBy(id);
  } catch (e) {
    // Failed creation remains visible for inspection/removal; never alter main.
    await db.query(
      "UPDATE workspaces SET status='failed' WHERE id=$1 AND status='preparing'",
      [id],
    );
    await db.query(
      "UPDATE workspace_operations SET status='failed' WHERE id=$1 AND status='preparing'",
      [op],
    );
    throw e;
  } finally {
    await releaseFolder(mainId);
  }
}
async function resolutionInput(w: Workspace) {
  if (!w.resolution_operation_id) return {};
  const op = (
    await db.query("SELECT result FROM workspace_operations WHERE id=$1", [
      w.resolution_operation_id,
    ])
  ).rows[0];
  if (!Array.isArray(op?.result?.conflicts))
    fail(
      "The resolution preparation is incomplete. Delete this folder and try again.",
    );
  return { resolutionPaths: op.result.conflicts };
}
export async function reviewCopy(id: string) {
  const w = await workspaceBy(id),
    main = await mainFor(w),
    op = randomUUID();
  await acquireFolders([id, main.id], "reviewing changes");
  try {
    const current = await workspaceBy(id);
    const result = await folderHelper(
      "review",
      op,
      {
        main: workspacePath(main.id),
        copy: workspacePath(id),
        base: operationPath(current.base_snapshot_id!),
      },
      await resolutionInput(current),
    );
    await db.query(
      "INSERT INTO workspace_operations(id,kind,workspace_id,main_workspace_id,status,result,base_snapshot_id) VALUES($1,'review',$2,$3,'reviewed',$4,$5)",
      [op, id, main.id, JSON.stringify(result), current.base_snapshot_id],
    );
    const superseded = (
      await db.query(
        "UPDATE workspace_operations SET status='superseded',result=NULL WHERE workspace_id=$1 AND kind='review' AND status='reviewed' AND id<>$2 RETURNING id",
        [id, op],
      )
    ).rows;
    for (const old of superseded) await discardReview(old.id).catch(() => {});
    return { id: op, ...result };
  } catch (e) {
    await rm(operationPath(op), { recursive: true, force: true });
    throw e;
  } finally {
    await releaseFolder(id);
    await releaseFolder(main.id);
  }
}
export async function applyCopy(
  id: string,
  reviewId: string,
  choices: Record<string, "main" | "copy">,
) {
  const w = await workspaceBy(id),
    main = await mainFor(w);
  await acquireFolders(
    [id, main.id, ...(w.resolution_source_id ? [w.resolution_source_id] : [])],
    "transferring changes",
  );
  try {
    const op = (
      await db.query(
        "SELECT * FROM workspace_operations WHERE id=$1 AND workspace_id=$2 AND kind='review'",
        [reviewId, id],
      )
    ).rows[0];
    if (!op) fail("Review not found. Refresh the review.");
    if (op.status === "applied") return { ok: true, checkpoint: reviewId };
    if (
      op.status !== "reviewed" ||
      op.result?.reviewVersion !== 2 ||
      op.base_snapshot_id !== (await workspaceBy(id)).base_snapshot_id
    )
      fail("This review is out of date. Refresh the review.");
    let originalReview: any;
    if (w.resolution_source_id) {
      originalReview = (
        await db.query("SELECT * FROM workspace_operations WHERE id=$1", [
          w.resolution_review_id,
        ])
      ).rows[0];
      const original = await workspaceBy(w.resolution_source_id);
      if (
        !originalReview ||
        originalReview.status !== "resolving" ||
        original.base_snapshot_id !== originalReview.base_snapshot_id
      )
        fail(
          "The original copy has already been transferred since this resolution started. Review its latest changes and start a new resolution.",
        );
    }
    await folderHelper(
      "apply",
      reviewId,
      {
        main: workspacePath(main.id),
        copy: workspacePath(id),
        base: operationPath(op.base_snapshot_id),
      },
      { ...op.result, choices, ...(await resolutionInput(w)) },
    );
    await prepare(path.dirname(checkpointPath(reviewId)));
    await transaction(async (c) => {
      await c.query(
        "UPDATE workspace_operations SET status='applying' WHERE id=$1",
        [reviewId],
      );
      await c.query(
        "UPDATE workspaces SET status='applying' WHERE id=ANY($1::uuid[])",
        [[id, main.id]],
      );
    });
    await rename(workspacePath(main.id), checkpointPath(reviewId));
    await rename(
      path.join(operationPath(reviewId), "prepared"),
      workspacePath(main.id),
    );
    await transaction(async (c) => {
      await c.query(
        "UPDATE workspace_operations SET status='applied' WHERE id=$1",
        [reviewId],
      );
      await c.query(
        "UPDATE workspaces SET status='ready' WHERE id=ANY($1::uuid[])",
        [[id, main.id]],
      );
      await c.query(
        "UPDATE workspaces SET base_snapshot_id=$2,last_applied_at=now() WHERE id=$1",
        [id, reviewId],
      );
      if (w.resolution_source_id) {
        await c.query(
          "UPDATE workspaces SET base_snapshot_id=$2,last_applied_at=now() WHERE id=$1",
          [w.resolution_source_id, w.resolution_review_id],
        );
        await c.query(
          "UPDATE workspace_operations SET status='resolved' WHERE id=$1",
          [w.resolution_review_id],
        );
        await c.query(
          "UPDATE workspaces SET resolution_source_id=NULL,resolution_review_id=NULL,resolution_operation_id=NULL WHERE id=$1",
          [id],
        );
      }
    });
    return { ok: true, checkpoint: reviewId };
  } catch (e) {
    const op = (
      await db.query("SELECT * FROM workspace_operations WHERE id=$1", [
        reviewId,
      ])
    ).rows[0];
    if (op?.status === "applying") await recoverOperation(op);
    if (op?.status === "applied") return { ok: true, checkpoint: reviewId };
    throw e;
  } finally {
    await releaseFolder(id);
    await releaseFolder(main.id);
    if (w.resolution_source_id) await releaseFolder(w.resolution_source_id);
  }
}
export async function recoverOperation(op: any) {
  if (op.status === "applying") {
    const main = workspacePath(op.main_workspace_id),
      backup = checkpointPath(op.id);
    if (await exists(backup)) {
      if (await exists(main))
        await rename(
          main,
          path.join(operationPath(op.id), "unconfirmed-result"),
        );
      await rename(backup, main);
    } else if (!(await exists(main)))
      throw Error("Main folder recovery needs attention: " + op.id);
    await transaction(async (c) => {
      await c.query(
        "UPDATE workspaces SET status='ready' WHERE id=ANY($1::uuid[])",
        [[op.workspace_id, op.main_workspace_id]],
      );
      await c.query(
        "UPDATE workspace_operations SET status='failed' WHERE id=$1",
        [op.id],
      );
    });
  } else if (op.status === "preparing") {
    await db.query("UPDATE workspaces SET status='failed' WHERE id=$1", [
      op.workspace_id,
    ]);
    await db.query(
      "UPDATE workspace_operations SET status='failed' WHERE id=$1",
      [op.id],
    );
  }
}
async function discardReview(id: string) {
  await rm(operationPath(id), { recursive: true, force: true });
  await db.query(
    "UPDATE workspace_operations SET status='discarded' WHERE id=$1 AND status='superseded'",
    [id],
  );
}
export async function recoverFolderOperations() {
  for (const op of (
    await db.query(
      "SELECT id FROM workspace_operations WHERE status='superseded'",
    )
  ).rows)
    await discardReview(op.id);

  for (const op of (
    await db.query(
      "SELECT * FROM workspace_operations WHERE status IN ('applying','preparing')",
    )
  ).rows)
    await recoverOperation(op);
  for (const op of (
    await db.query(
      "SELECT * FROM workspace_operations WHERE status IN ('deleting','cleanup')",
    )
  ).rows)
    await recoverDeletion(op);
}
export async function deletionInfo(id: string) {
  const w = await workspaceBy(id);
  if (w.kind === "main") fail("The main folder cannot be deleted here.");
  const chats = (
    await db.query("SELECT id,title FROM chats WHERE workspace_id=$1", [id])
  ).rows;
  return {
    name: w.name,
    chats,
    attachments: Number(
      (
        await db.query(
          "SELECT count(*) n FROM attachments WHERE workspace_id=$1",
          [id],
        )
      ).rows[0].n,
    ),
    hasBaseline: !!w.base_snapshot_id,
  };
}
async function cleanupDeleted(op: any) {
  if (op.result.gitSource) {
    const repo = workspaceGitPath(op.result.gitSource);
    if (await exists(repo))
      await transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(417029,hashtext($1))", [
          op.result.gitSource,
        ]);
        await folderHelper(
          "unlink-worktree",
          op.id,
          {},
          {
            id: op.result.workspaceId,
            mainId: op.result.gitSource,
            branch: op.result.branch,
          },
          { ["workspace-git/" + op.result.gitSource]: repo },
        );
      });
  }

  await rm(path.join(operationPath(op.id), "deleted-folder"), {
    recursive: true,
    force: true,
  });
  for (const name of op.result.staging || [])
    await rm(path.join(config.data, "workspaces", name), {
      recursive: true,
      force: true,
    });
  for (const file of op.result.uploads)
    await rm(path.join(config.data, "uploads", path.basename(file)), {
      force: true,
    });
  await removeChatSessions(op.result.chats || []);
  for (const id of op.result.operations)
    if (id !== op.id)
      await rm(operationPath(id), { recursive: true, force: true });
  await db.query(
    "UPDATE workspace_operations SET status='deleted' WHERE id=$1",
    [op.id],
  );
}
export async function deleteWorkingFolder(id: string, name: string) {
  const opid = randomUUID();
  let folder: Workspace;
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417028)");
    const w = await workspaceBy(id, c);
    folder = w;
    if (
      (
        await c.query(
          "SELECT name FROM workspaces WHERE resolution_source_id=$1",
          [id],
        )
      ).rowCount
    )
      fail(
        "Finish or delete the conflict-resolution folder before deleting its source copy.",
      );
    if (w.kind === "main") fail("The main folder cannot be deleted here.");
    if (name !== w.name) fail("Type the folder name to confirm deletion.");
    const { workspaceBusy } = await import("./workspaces.js");
    if (await workspaceBusy(id, c, true))
      fail("Stop all tasks and close terminals in this folder first.");
    await c.query("UPDATE workspaces SET status='deleting' WHERE id=$1", [id]);
    await c.query(
      "INSERT INTO workspace_operations(id,kind,workspace_id,status,result) VALUES($1,'delete',$2,'deleting',$3)",
      [opid, id, JSON.stringify({ previousStatus: w.status })],
    );
  });
  const trash = path.join(operationPath(opid), "deleted-folder");
  try {
    await prepare(operationPath(opid));
    if (await exists(workspacePath(id))) await rename(workspacePath(id), trash);
    const staging = (
      await readdir(path.dirname(workspacePath(id))).catch(() => [])
    ).filter(
      (name) =>
        name === id + ".initializing" ||
        name.startsWith(id + ".initializing.preserved-"),
    );
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(417028)");
      const chatIds = (
        await c.query("SELECT id FROM chats WHERE workspace_id=$1 FOR UPDATE", [
          id,
        ])
      ).rows.map((r) => r.id);
      const uploads = (
        await c.query(
          "SELECT storage_name FROM attachments WHERE workspace_id=$1",
          [id],
        )
      ).rows.map((r) => r.storage_name);
      const operations = (
        await c.query(
          "SELECT id FROM workspace_operations WHERE workspace_id=$1",
          [id],
        )
      ).rows.map((r) => r.id);
      const chats = "SELECT id FROM chats WHERE workspace_id=$1";
      const jobs = `SELECT id FROM jobs WHERE chat_id IN (${chats})`;
      await c.query(`DELETE FROM approvals WHERE job_id IN (${jobs})`, [id]);
      await c.query(
        `DELETE FROM events WHERE chat_id IN (${chats}) OR job_id IN (${jobs})`,
        [id],
      );
      await c.query(`DELETE FROM publications WHERE chat_id IN (${chats})`, [
        id,
      ]);
      await c.query(`DELETE FROM jobs WHERE chat_id IN (${chats})`, [id]);
      await c.query("DELETE FROM attachments WHERE workspace_id=$1", [id]);
      await c.query(`DELETE FROM messages WHERE chat_id IN (${chats})`, [id]);
      await c.query("DELETE FROM chats WHERE workspace_id=$1", [id]);
      await c.query("DELETE FROM workspace_leases WHERE workspace_id=$1", [id]);
      await c.query(
        "UPDATE workspace_operations SET result=NULL WHERE workspace_id=$1 AND kind<>'delete'",
        [id],
      );
      if (folder!.resolution_review_id)
        await c.query(
          "UPDATE workspace_operations SET status='reviewed' WHERE id=$1 AND status='resolving'",
          [folder!.resolution_review_id],
        );
      await c.query("DELETE FROM workspaces WHERE id=$1", [id]);
      await c.query(
        "UPDATE workspace_operations SET status='cleanup',result=$2 WHERE id=$1",
        [
          opid,
          JSON.stringify({
            uploads,
            operations,
            staging,
            chats: chatIds,
            workspaceId: id,
            branch: folder!.branch,
            gitSource:
              folder!.git_source_id ||
              (folder!.kind === "copy" ? folder!.source_workspace_id : null),
          }),
        ],
      );
    });
  } catch (e) {
    const op = (
      await db.query("SELECT * FROM workspace_operations WHERE id=$1", [opid])
    ).rows[0];
    if (op?.status === "deleting") await recoverDeletion(op);
    if (op?.status !== "cleanup") throw e;
  }
  const op = (
    await db.query("SELECT * FROM workspace_operations WHERE id=$1", [opid])
  ).rows[0];
  try {
    await cleanupDeleted(op);
    return { ok: true, cleanupPending: false };
  } catch {
    return { ok: true, cleanupPending: true };
  }
}
async function recoverDeletion(op: any) {
  const trash = path.join(operationPath(op.id), "deleted-folder");
  if (op.status === "cleanup") {
    await cleanupDeleted(op);
    return;
  }
  if (await exists(trash)) await rename(trash, workspacePath(op.workspace_id));
  await db.query("UPDATE workspaces SET status=$2 WHERE id=$1", [
    op.workspace_id,
    op.result?.previousStatus || "ready",
  ]);
  await db.query(
    "UPDATE workspace_operations SET status='failed' WHERE id=$1",
    [op.id],
  );
}
