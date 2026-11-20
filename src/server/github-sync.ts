import { chown, lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { validRepo, type GithubSyncResult } from "../shared.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { git, projectToken } from "./git.js";
import { workspaceBy, workspaceGitPath, workspacePath } from "./workspaces.js";

type RunGit = (args: string[]) => Promise<string>;
const incomingRef = "refs/workspace-sync/incoming";

function blocked(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}

export async function applyGithubUpdate(
  run: RunGit,
  localBranch: string,
  sourceBranch: string,
  incoming: string,
): Promise<GithubSyncResult> {
  const branch = await run(["symbolic-ref", "-q", "HEAD"]).catch((error) => {
    if (error.gitExitCode === 1) return "";
    throw error;
  });
  if (branch.trim() !== `refs/heads/${localBranch}`)
    blocked("Switch back to this folder’s Workspace branch before syncing.");
  const head = (await run(["rev-parse", "--verify", "HEAD"])).trim();
  const [localCount, remoteCount] = (
    await run(["rev-list", "--left-right", "--count", `${head}...${incoming}`])
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  if (remoteCount === 0)
    return { status: "current", sourceBranch, commit: head };

  const customDrivers = await run([
    "config",
    "--name-only",
    "--get-regexp",
    "^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver)$",
  ]).catch((error) => {
    if (error.gitExitCode === 1) return "";
    throw error;
  });
  if (customDrivers)
    blocked(
      "This folder uses custom Git filters or merge drivers. Sync from an authenticated Git checkout instead.",
    );
  if (
    await run([
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ])
  )
    blocked(
      "This folder has uncommitted changes. Commit them or move untracked files before syncing.",
    );
  const indexEntries = await run(["ls-files", "-v", "-z"]);
  if (indexEntries.split("\0").some((entry) => /^[Sa-z] /.test(entry)))
    blocked(
      "This folder has Git index entries marked to skip change checks. Restore normal tracking before syncing.",
    );

  let target = incoming;
  if (localCount > 0) {
    let tree: string;
    try {
      tree = (
        await run([
          "merge-tree",
          "--write-tree",
          "--no-messages",
          head,
          incoming,
        ])
      ).trim();
    } catch (error: any) {
      if (error.gitExitCode === 1)
        blocked(
          "GitHub changes conflict with local commits. Resolve the conflict in a separate branch before syncing.",
        );
      if (error.message.includes("refusing to merge unrelated histories"))
        blocked("This folder and the GitHub branch do not share Git history.");
      throw error;
    }
    // Compute the merge before touching the index, working files, or branch.
    target = (
      await run([
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        "-p",
        head,
        "-p",
        incoming,
        "-m",
        `Sync ${sourceBranch} from GitHub`,
      ])
    ).trim();
  }
  try {
    await run([
      "-c",
      "submodule.recurse=false",
      "merge",
      "--ff-only",
      "--no-autostash",
      "--no-overwrite-ignore",
      "--no-stat",
      "--no-edit",
      "--no-verify-signatures",
      "--",
      target,
    ]);
  } catch (error: any) {
    if (
      /would be overwritten|would lose untracked files|not uptodate|untracked working tree/i.test(
        error.message,
      )
    )
      blocked(
        "GitHub changes would replace local files. Move the affected files before syncing.",
      );
    throw error;
  }
  return { status: "updated", sourceBranch, commit: target };
}

// Owner requests hold a folder lease. Agent requests already own the job's
// folder and must stop the runner from writing during the local apply step.
export async function syncFromGithub(
  workspaceId: string,
  apply: (
    operation: () => Promise<GithubSyncResult>,
  ) => Promise<GithubSyncResult> = (operation) => operation(),
) {
  const w = await workspaceBy(workspaceId);
  if (!w.initialized || w.status !== "ready" || w.resolution_operation_id)
    blocked(
      "Sync is available for initialized Git folders outside conflict resolution.",
    );
  const project = (
    await db.query(
      "SELECT repo,base_branch,github_token FROM projects WHERE id=$1",
      [w.project_id],
    )
  ).rows[0];
  if (!project?.repo || !validRepo(project.repo))
    blocked("Connect this project to a GitHub repository first.");

  const scratch = await mkdtemp(path.join(config.data, "github-sync-"));
  try {
    if (process.getuid?.() === 0) await chown(scratch, 1000, 1000);
    const ref = `refs/heads/${project.base_branch}`;
    await git(scratch, ["init", "--bare"]);
    await git(scratch, ["check-ref-format", ref]);
    try {
      // Credentials only reach the freshly initialized repository and the
      // configured GitHub HTTPS URL. Local Git configuration is never mounted.
      await git(
        scratch,
        [
          "-c",
          "http.followRedirects=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-auto-maintenance",
          "--",
          `https://github.com/${project.repo}.git`,
          ref,
        ],
        true,
        [],
        projectToken(project),
      );
    } catch {
      blocked(
        `Could not fetch ${project.base_branch} from GitHub. Check that the branch exists and the project token has access to its contents.`,
      );
    }
    const incoming = (
      await git(scratch, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
    ).trim();
    await git(scratch, ["update-ref", incomingRef, incoming]);
    await git(scratch, [
      "bundle",
      "create",
      "/workspace/incoming.bundle",
      incomingRef,
    ]);
    return await apply(async () => {
      const cwd = workspacePath(w.id);
      const gitDir = w.git_source_id
        ? path.join(workspaceGitPath(w.git_source_id), "worktrees", w.id)
        : path.join(cwd, ".git");
      if (!(await lstat(gitDir).catch(() => null))?.isDirectory())
        blocked("This folder does not have its expected Git metadata.");
      const markers = await Promise.all(
        [
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "rebase-apply",
          "rebase-merge",
          "sequencer",
        ].map((name) =>
          lstat(path.join(gitDir, name)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return null;
          }),
        ),
      );
      if (markers.some(Boolean))
        blocked("Finish the active Git operation before syncing this folder.");
      const gitPaths = w.git_source_id
        ? []
        : ["--git-dir=/workspace/.git", "--work-tree=/workspace"];
      const run: RunGit = (args) => git(cwd, [...gitPaths, ...args]);
      await git(
        cwd,
        [
          ...gitPaths,
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.file.allow=always",
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "--no-auto-maintenance",
          "--",
          "/github-sync/incoming.bundle",
          incomingRef,
        ],
        false,
        [
          {
            Type: "bind",
            Source: scratch,
            Target: "/github-sync",
            ReadOnly: true,
          },
        ],
      );
      return applyGithubUpdate(run, w.branch, project.base_branch, incoming);
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
