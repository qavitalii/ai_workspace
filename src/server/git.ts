import { randomUUID } from "node:crypto";
import { mkdir, rm, rename, access, chown, readdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { unseal } from "./security.js";
import {
  chatWorkspace,
  workspaceBy,
  workspacePath,
  type Workspace,
  workspaceGitMounts,
  validateWorktree,
} from "./workspaces.js";
import { docker } from "./runtime.js";

export function projectToken(project: { github_token?: string }): string {
  return project.github_token ? unseal(project.github_token) : "";
}
export async function github(
  pathname: string,
  method = "GET",
  body?: unknown,
  token = "",
) {
  const res = await fetch("https://api.github.com" + pathname, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw Object.assign(
      new Error("GitHub request failed (" + res.status + ")"),
      { statusCode: 502, githubStatus: res.status },
    );
  return res.json() as Promise<any>;
}
async function prepare(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.getuid?.() === 0) await chown(dir, 1000, 1000);
}
/** Git runs in a separate unprivileged helper: repository config, filters and hooks never execute on the supervisor. */
export async function git(
  cwd: string,
  args: string[],
  authenticated = false,
  extraMounts: any[] = [],
  token = "",
) {
  const w =
    path.dirname(cwd) === path.join(config.data, "workspaces") &&
    /^[0-9a-f-]{36}$/.test(path.basename(cwd))
      ? (
          await db.query("SELECT * FROM workspaces WHERE id=$1", [
            path.basename(cwd),
          ])
        ).rows[0]
      : null;
  if (!w?.git_source_id)
    return runGit(cwd, args, authenticated, extraMounts, token);
  await validateWorktree(w);
  const { transaction } = await import("./db.js");
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(417029,hashtext($1))", [
      w.git_source_id,
    ]);
    return runGit(
      cwd,
      args,
      authenticated,
      [...workspaceGitMounts(w, true), ...extraMounts],
      token,
      `/workspace-git/${w.git_source_id}/worktrees/${w.id}`,
    );
  });
}
async function runGit(
  cwd: string,
  args: string[],
  authenticated = false,
  extraMounts: any[] = [],
  token = "",
  gitDirectory = "",
) {
  const c = await docker.createContainer({
    Image: config.image,
    User: "1000:1000",
    WorkingDir: "/workspace",
    Cmd: [
      "git",
      "-c",
      "safe.directory=/workspace",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...(gitDirectory
        ? ["--git-dir=" + gitDirectory, "--work-tree=/workspace"]
        : []),
      ...args,
    ],
    Env: [
      "HOME=/tmp",
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_AUTHOR_NAME=Workspace",
      "GIT_AUTHOR_EMAIL=workspace@localhost",
      "GIT_COMMITTER_NAME=Workspace",
      "GIT_COMMITTER_EMAIL=workspace@localhost",
      ...(token
        ? [
            "GIT_ASKPASS=/usr/local/bin/workspace-git-askpass",
            "WORKSPACE_GIT_TOKEN=" + token,
          ]
        : []),
    ],
    Labels: {
      "ai.workspace.managed": "true",
      "ai.workspace.instance": config.data,
    },
    HostConfig: {
      Mounts: [
        { Type: "bind", Source: cwd, Target: "/workspace" },
        ...extraMounts,
      ],
      NetworkMode: authenticated ? "bridge" : "none",
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=128m" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 512 * 1024 ** 2,
      PidsLimit: 128,
    },
    AttachStdout: true,
    AttachStderr: true,
  });
  let output = "",
    error = "";
  const stream = await c.attach({ stream: true, stdout: true, stderr: true }),
    out = new PassThrough(),
    err = new PassThrough();
  docker.modem.demuxStream(stream, out, err);
  const drained = finished(stream, { readable: true, writable: false });
  void drained.catch(() => {});
  out.on("data", (b) => {
    output += b;
    if (output.length > 4e6) void c.kill().catch(() => {});
  });
  err.on("data", (b) => {
    error = (error + b).slice(-4000);
  });
  const timer = setTimeout(() => void c.kill().catch(() => {}), 120000);
  try {
    await c.start();
    const result = await c.wait();
    await drained;
    if (result.StatusCode !== 0)
      throw new Error(error || "Git operation failed or timed out");
    return output;
  } finally {
    clearTimeout(timer);
    (stream as import("node:stream").Duplex).destroy();
    await c.remove({ force: true }).catch(() => {});
  }
}
export async function initializeWorkspace(chat: { id: string }) {
  return initializeFolder(await chatWorkspace(chat.id));
}
/** Caller holds a workspace lease or an active job for this folder. */
export async function initializeFolder(input: Workspace) {
  const w = await workspaceBy(input.id);
  if (w.initialized) return;
  const target = workspacePath(w.id),
    staging = target + ".initializing";
  const markReady = async () => {
    await db.query("UPDATE workspaces SET initialized=true WHERE id=$1", [
      w.id,
    ]);
    await db.query("UPDATE chats SET initialized=true WHERE workspace_id=$1", [
      w.id,
    ]);
  };
  if (!w.project_id) {
    await prepare(target);
    await markReady();
    return;
  }
  const p = (
    await db.query("SELECT * FROM projects WHERE id=$1", [w.project_id])
  ).rows[0];
  if (!p.repo) {
    await prepare(target);
    await markReady();
    await db.query("UPDATE workspaces SET storage_mode='folder' WHERE id=$1", [
      w.id,
    ]);
    return;
  }
  // Recover completed checkouts without changing existing files or Git state.
  try {
    await access(path.join(target, ".git"));
    const branch = (await git(target, ["branch", "--show-current"])).trim();
    if (branch !== w.branch)
      throw new Error(
        "Unexpected existing checkout; inspect it before retrying.",
      );
    await markReady();
    return;
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const existing = await readdir(target).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  if (existing.length)
    throw new Error(
      "This folder already contains files. They have been preserved; inspect the folder before initializing its repository.",
    );
  // Retain any old interrupted staging checkout for recovery, too.
  try {
    await rename(staging, staging + ".preserved-" + randomUUID());
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  await prepare(staging);
  await git(
    staging,
    [
      "clone",
      "--no-local",
      "--single-branch",
      "--branch",
      p.base_branch,
      "https://github.com/" + p.repo + ".git",
      ".",
    ],
    true,
    [],
    projectToken(p),
  );
  await git(staging, ["checkout", "-b", w.branch]);
  await git(staging, ["config", "core.hooksPath", "/dev/null"]);
  await git(staging, ["config", "user.name", "Workspace"]);
  await git(staging, ["config", "user.email", "workspace@localhost"]);
  await rename(staging, target);
  await markReady();
}
/** Publish from a fresh trusted repository, never exposing a GitHub token to agent-controlled Git configuration. */
export async function pushBranch(chat: any, project: any) {
  const w = await chatWorkspace(chat.id);
  const scratch = path.join(config.data, "publications", randomUUID()),
    exportDir = path.join(scratch, "export"),
    repoDir = path.join(scratch, "repo");
  await prepare(exportDir);
  await prepare(repoDir);
  try {
    await git(
      workspacePath(w.id),
      ["bundle", "create", "/export/change.bundle", "HEAD"],
      false,
      [{ Type: "bind", Source: exportDir, Target: "/export" }],
    );
    await git(repoDir, ["init"]);
    await git(
      repoDir,
      ["fetch", "/bundle/change.bundle", "HEAD:refs/heads/" + w.branch],
      false,
      [{ Type: "bind", Source: exportDir, Target: "/bundle", ReadOnly: true }],
    );
    return await git(
      repoDir,
      [
        "push",
        "https://github.com/" + project.repo + ".git",
        "refs/heads/" + w.branch + ":refs/heads/" + w.branch,
      ],
      true,
      [],
      projectToken(project),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
