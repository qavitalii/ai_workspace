import { randomUUID } from "node:crypto";
import { mkdir, rm, rename, access, chown, readdir } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { seal, unseal } from "./security.js";
import {
  candidateTree,
  renderPublication,
  requireReviewedState,
  trustedDiffOptions,
} from "./publication-review.js";
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
  indexFile = "",
  readOnly = false,
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
    return runGit(
      cwd,
      args,
      authenticated,
      extraMounts,
      token,
      "",
      indexFile,
      readOnly,
    );
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
      [...workspaceGitMounts(w, !readOnly), ...extraMounts],
      token,
      `/workspace-git/${w.git_source_id}/worktrees/${w.id}`,
      indexFile,
      readOnly,
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
  indexFile = "",
  readOnly = false,
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
      "GIT_NO_REPLACE_OBJECTS=1",
      ...(readOnly ? ["GIT_OPTIONAL_LOCKS=0"] : []),
      ...(indexFile ? ["GIT_INDEX_FILE=" + indexFile] : []),
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
        { Type: "bind", Source: cwd, Target: "/workspace", ReadOnly: readOnly },
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
    if (output.length > 4e6)
      throw new Error(
        "Git output exceeds the review limit. Reduce the change size before publishing.",
      );
    if (result.StatusCode !== 0)
      throw Object.assign(
        new Error(error || "Git operation failed or timed out"),
        {
          gitExitCode: result.StatusCode,
        },
      );
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
type PublicationState = {
  head: string;
  tree: string;
  workspace: string;
  repo: string;
  branch: string;
  baseBranch: string;
  remote: string | null;
};

async function withCandidate<T>(
  workspace: string,
  use: (state: { head: string; tree: string }) => Promise<T>,
) {
  const indexDir = path.join(config.data, "publications", randomUUID());
  await prepare(indexDir);
  try {
    const state = await candidateTree((args) =>
      git(
        workspacePath(workspace),
        args,
        false,
        [{ Type: "bind", Source: indexDir, Target: "/review-index" }],
        "",
        "/review-index/index",
      ),
    );
    return await use(state);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }
}

// Informational preview only; publication always requires a separate frozen review.
export async function localChanges(chat: { id: string }) {
  const w = await chatWorkspace(chat.id);
  const run = (args: string[]) =>
    git(workspacePath(w.id), args, false, [], "", "", true);
  const paths = ["--", ".", ":!.workspace-attachments", ":!.workspace-folders"];
  const diff = await run(["diff", ...trustedDiffOptions, "HEAD", ...paths]);
  const untracked = (
    await run(["ls-files", "--others", "--exclude-standard", "-z", ...paths])
  )
    .split("\0")
    .filter(Boolean);
  return { diff, untracked };
}

/** Caller holds the workspace lease for the whole review. */
export async function reviewPublication(
  chat: any,
  project: any,
  outgoing = true,
) {
  const w = await chatWorkspace(chat.id);
  return withCandidate(w.id, async (state) => {
    const scratch = path.join(config.data, "publications", randomUUID());
    const repo = path.join(scratch, "repo"),
      exported = path.join(scratch, "export");
    const ref = "refs/workspace-reviews/" + randomUUID();
    let commit = "";
    await prepare(repo);
    await prepare(exported);
    try {
      commit = (
        await git(workspacePath(w.id), [
          "commit-tree",
          state.tree,
          "-p",
          state.head,
          "-m",
          "Publication review",
        ])
      ).trim();
      await git(workspacePath(w.id), ["update-ref", ref, commit, ""]);
      await git(
        workspacePath(w.id),
        ["bundle", "create", "/export/review.bundle", ref],
        false,
        [{ Type: "bind", Source: exported, Target: "/export" }],
      );
      await git(repo, ["init"]);
      await git(
        repo,
        ["fetch", "/export/review.bundle", ref + ":refs/review/candidate"],
        false,
        [{ Type: "bind", Source: exported, Target: "/export", ReadOnly: true }],
      );
      const run = (args: string[]) => git(repo, args);
      let remote: string | null = null;
      let pushError = "";
      let rendered = await renderPublication(
        run,
        state.head,
        state.tree,
        state.head,
      );
      if (outgoing)
        try {
          const url = "https://github.com/" + project.repo + ".git";
          const remoteRef = "refs/heads/" + w.branch;
          const advertised = (
            await git(
              repo,
              ["ls-remote", "--refs", url, remoteRef],
              true,
              [],
              projectToken(project),
            )
          )
            .trim()
            .split(/\s/)[0];
          const baselineRef = advertised
            ? remoteRef
            : "refs/heads/" + project.base_branch;
          await git(
            repo,
            ["fetch", "--no-tags", url, baselineRef],
            true,
            [],
            projectToken(project),
          );
          const baseline = (
            await git(repo, ["rev-parse", "FETCH_HEAD"])
          ).trim();
          if (advertised && advertised !== baseline)
            throw Error("Remote branch changed. Refresh the review.");
          rendered = await renderPublication(
            run,
            state.head,
            state.tree,
            baseline,
          );
          remote = advertised;
        } catch {
          pushError =
            "Outgoing commits could not be verified against GitHub. Refresh the review before Push or Create PR.";
        }
      const review: PublicationState = {
        ...state,
        workspace: w.id,
        repo: project.repo,
        branch: w.branch,
        baseBranch: project.base_branch,
        remote,
      };
      return {
        ...rendered,
        pushError,
        review_token: seal(JSON.stringify(review)),
      };
    } finally {
      if (commit)
        await git(workspacePath(w.id), ["update-ref", "-d", ref, commit]).catch(
          () => {},
        );
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

export async function validatePublication(
  chat: any,
  project: any,
  token: string,
): Promise<PublicationState> {
  let review: PublicationState;
  try {
    review = JSON.parse(unseal(token));
  } catch {
    throw Object.assign(new Error("Refresh the publication review."), {
      statusCode: 409,
    });
  }
  const w = await chatWorkspace(chat.id);
  if (
    review.workspace !== w.id ||
    review.repo !== project.repo ||
    review.branch !== w.branch ||
    review.baseBranch !== project.base_branch
  )
    throw Object.assign(
      new Error("Publication destination changed. Refresh the review."),
      { statusCode: 409 },
    );
  await withCandidate(w.id, async (state) =>
    requireReviewedState(state, review),
  );
  return review;
}

export async function commitReviewed(
  review: PublicationState,
  message: string,
) {
  const cwd = workspacePath(review.workspace);
  const oldTree = (
    await git(cwd, ["rev-parse", review.head + "^{tree}"])
  ).trim();
  if (oldTree === review.tree)
    throw Object.assign(new Error("No changes to commit."), {
      statusCode: 409,
    });
  const commit = (
    await git(cwd, [
      "commit-tree",
      review.tree,
      "-p",
      review.head,
      "-m",
      message,
    ])
  ).trim();
  await git(cwd, ["update-ref", "HEAD", commit, review.head]);
  await git(cwd, ["read-tree", review.tree]);
  return commit;
}

/** Publish from a fresh trusted repository, never exposing a GitHub token to agent-controlled Git configuration. */
export async function pushBranch(
  chat: any,
  project: any,
  review: PublicationState,
) {
  if (review.remote === null)
    throw Object.assign(
      new Error("Refresh the outgoing commits review before pushing."),
      { statusCode: 409 },
    );
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
    const imported = (
      await git(repoDir, ["rev-parse", "refs/heads/" + w.branch])
    ).trim();
    if (imported !== review.head)
      throw Error("Commits changed. Refresh the publication review.");
    if (review.remote) {
      await git(
        repoDir,
        [
          "fetch",
          "--no-tags",
          "https://github.com/" + project.repo + ".git",
          "refs/heads/" + w.branch,
        ],
        true,
        [],
        projectToken(project),
      );
      const remote = (await git(repoDir, ["rev-parse", "FETCH_HEAD"])).trim();
      if (remote !== review.remote)
        throw Error("Remote branch changed. Refresh the publication review.");
      // A lease protects against remote races, while this check prohibits history rewrites.
      await git(repoDir, ["merge-base", "--is-ancestor", remote, imported]);
    }
    return await git(
      repoDir,
      [
        "push",
        "--force-with-lease=refs/heads/" + w.branch + ":" + review.remote,
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
