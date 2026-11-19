import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  snapshot,
  mergeTrees,
  overlay,
  preview,
  type Node,
} from "./folder-tree.js";
const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return exec(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "credential.helper=",
      ...args,
    ],
    {
      cwd,
      maxBuffer: 4000000,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "Workspace",
        GIT_AUTHOR_EMAIL: "workspace@localhost",
        GIT_COMMITTER_NAME: "Workspace",
        GIT_COMMITTER_EMAIL: "workspace@localhost",
      },
    },
  );
}
async function historyBundle(source: string): Promise<string | null> {
  try {
    await git(source, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch (e: any) {
    if (e.code === 1) return null;
    throw e;
  }
  await git(source, ["bundle", "create", "/operation/history.bundle", "HEAD"]);
  return "/operation/history.bundle";
}
async function linkedTree(input: any, bundle: string | null) {
  const repo = "/workspace-git/" + input.mainId;
  if (!(await fs.stat(repo + "/HEAD").catch(() => null)))
    await git(repo, ["init", "--bare"]);
  let start = "FETCH_HEAD";
  if (bundle)
    await git(repo, ["fetch", "--no-auto-maintenance", bundle, "HEAD"]);
  else {
    const tree = (
      await git(repo, ["hash-object", "-w", "-t", "tree", "/dev/null"])
    ).stdout.trim();
    start = (
      await git(repo, [
        "commit-tree",
        tree,
        "-m",
        "Empty project starting point",
      ])
    ).stdout.trim();
  }
  await git(repo, [
    "worktree",
    "add",
    "--no-checkout",
    "--lock",
    "--reason",
    "Managed by Workspace",
    "-b",
    input.branch,
    "/operation/" + input.id,
    start,
  ]);
  await fs.rename("/operation/" + input.id, "/operation/prepared");
  // The Git file uses a stable container path shared by helpers and runners.
  await fs.writeFile(
    "/operation/prepared/.git",
    "gitdir: " + repo + "/worktrees/" + input.id + "\n",
  );
  await fs.writeFile(
    repo + "/worktrees/" + input.id + "/gitdir",
    "/operation/prepared/.git\n",
  );
  await git("/operation/prepared", ["read-tree", "HEAD"]);
}
async function relocateTree(input: any) {
  await fs.writeFile(
    "/workspace-git/" + input.mainId + "/worktrees/" + input.id + "/gitdir",
    "/worktrees/" + input.id + "/.git\n",
  );
}
function at(tree: Node, relative: string): Node | undefined {
  return relative
    .split("/")
    .reduce<Node | undefined>((node, name) => node?.children?.[name], tree);
}
async function resolutionCheck(tree: Node, paths: string[]) {
  try {
    const receipt = JSON.parse(
      await fs.readFile("/copy/.workspace-resolution.json", "utf8"),
    );
    if (
      !Array.isArray(receipt.resolved_paths) ||
      paths.some((p) => !receipt.resolved_paths.includes(p))
    )
      return "The agent has not confirmed all conflicts yet. Continue the resolution chat.";
    async function check(node: Node): Promise<boolean> {
      if (node.kind === "dir") {
        for (const n of Object.values(node.children!))
          if (await check(n)) return true;
      }
      if (node.kind === "file") {
        const b = await fs.readFile(node.source);
        return (
          b.includes(Buffer.from("<<<<<<< WORKSPACE MAIN")) ||
          b.includes(Buffer.from(">>>>>>> WORKSPACE COPY")) ||
          b.includes(Buffer.from("||||||| WORKSPACE BASE"))
        );
      }
      return false;
    }
    if (await check(tree))
      return "Conflict markers remain. Ask the agent to finish resolving them.";
    return "";
  } catch {
    return "The resolution checklist is missing or invalid. Continue the resolution chat.";
  }
}
async function run() {
  const command = process.argv[2],
    input = JSON.parse(process.argv[3] || "{}");
  if (command === "create") {
    const initial = await snapshot("/main", "/operation/copy");
    const hasGit = await fs.lstat("/main/.git").catch(() => null);
    if (hasGit) {
      await linkedTree(input, await historyBundle("/main"));
    } else await fs.mkdir("/operation/prepared");
    for (const [name, node] of Object.entries(initial.tree.children!))
      await overlay("/operation/prepared/" + name, undefined, node);
    if (hasGit) {
      await git("/operation/prepared", ["add", "--all", "--force"]);
      await git("/operation/prepared", [
        "commit",
        "--allow-empty",
        "-m",
        "Working copy starting snapshot",
      ]);
      await relocateTree(input);
    }
    return {
      excluded: initial.excluded,
      storageMode: hasGit ? "worktree" : "folder",
    };
  }
  if (command === "unlink-worktree") {
    const repo = "/workspace-git/" + input.mainId,
      admin = repo + "/worktrees/" + input.id;
    // Each registered tree is locked because other trees are deliberately not mounted.
    // Remove only this tree's registration; never prune unrelated trees.
    await fs.rm(admin, { recursive: true, force: true });
    if (await fs.stat(repo + "/HEAD").catch(() => null))
      await git(repo, ["update-ref", "-d", "refs/heads/" + input.branch]);
    return { ok: true };
  }
  if (command === "resolve") {
    const liveCopy = await snapshot("/source"),
      liveMain = await snapshot("/main");
    if (
      liveCopy.tree.hash !== input.copyHash ||
      liveMain.tree.hash !== input.mainHash
    )
      throw Error(
        "Files changed after this review. Refresh the review before asking an agent to resolve conflicts.",
      );
    const base = await snapshot("/base/copy", "/operation/inputs/base"),
      copy = await snapshot("/review/copy", "/operation/inputs/copy"),
      main = await snapshot("/review/main", "/operation/copy");
    await snapshot("/review/main", "/operation/inputs/main");
    const first = await mergeTrees(
      base.tree,
      copy.tree,
      main.tree,
      "/operation/merged",
    );
    const conflicts = first.changes.filter((c) => c.conflict);
    if (!conflicts.length)
      throw Error("No conflicts need an agent. Refresh the review.");
    const result = await mergeTrees(
      base.tree,
      copy.tree,
      main.tree,
      "/operation/resolved",
      Object.fromEntries(conflicts.map((c) => [c.path, "copy"])),
    );
    const hasGit = await fs.lstat("/source/.git").catch(() => null);
    if (hasGit) {
      await linkedTree(input, await historyBundle("/source"));
    } else await fs.mkdir("/operation/prepared");
    for (const [name, node] of Object.entries(main.tree.children!))
      await overlay("/operation/prepared/" + name, undefined, node);
    if (hasGit) {
      await git("/operation/prepared", ["add", "--all", "--force"]);
      await git("/operation/prepared", [
        "commit",
        "--allow-empty",
        "-m",
        "Main folder before conflict resolution",
      ]);
    }
    await overlay("/operation/prepared", main.tree, result.tree);
    for (const change of conflicts) {
      const b = at(base.tree, change.path),
        c = at(copy.tree, change.path),
        m = at(main.tree, change.path);
      if ([b, c, m].every((n) => !n || n.kind === "file")) {
        const texts = await Promise.all(
          [m, b, c].map((n) => (n ? preview(n) : Promise.resolve(""))),
        );
        if (texts.every((t) => t !== null)) {
          await fs.mkdir(
            (await import("node:path")).dirname(
              "/operation/prepared/" + change.path,
            ),
            { recursive: true },
          );
          await fs.writeFile(
            "/operation/prepared/" + change.path,
            "<<<<<<< WORKSPACE MAIN\n" +
              texts[0] +
              "\n||||||| WORKSPACE BASE\n" +
              texts[1] +
              "\n=======\n" +
              texts[2] +
              "\n>>>>>>> WORKSPACE COPY\n",
          );
        }
      }
    }
    await fs.writeFile(
      "/operation/inputs/conflicts.json",
      JSON.stringify(conflicts, null, 2),
    );
    await fs.writeFile(
      "/operation/prepared/.workspace-resolution.json",
      JSON.stringify(
        {
          resolved_paths: [],
          checks: "Record checks performed and any limitations here.",
        },
        null,
        2,
      ),
    );
    if (hasGit) await relocateTree(input);
    return {
      storageMode: hasGit ? "worktree" : "folder",
      conflicts: conflicts.map((c) => c.path),
      excluded: [
        ...new Set([...base.excluded, ...copy.excluded, ...main.excluded]),
      ],
    };
  }
  if (command === "review") {
    const base = await snapshot("/base/copy"),
      copy = await snapshot("/copy", "/operation/copy"),
      main = await snapshot("/main", "/operation/main");
    const result = await mergeTrees(
      base.tree,
      copy.tree,
      main.tree,
      "/operation/merged",
    );
    return {
      changes: result.changes,
      reviewVersion: 2,
      copyHash: copy.tree.hash,
      mainHash: main.tree.hash,
      excluded: [...new Set([...copy.excluded, ...main.excluded])],
      ...(input.resolutionPaths
        ? {
            resolutionMessage: await resolutionCheck(
              copy.tree,
              input.resolutionPaths,
            ),
          }
        : {}),
    };
  }
  if (command === "apply") {
    const copy = await snapshot("/copy"),
      main = await snapshot("/main");
    if (copy.tree.hash !== input.copyHash || main.tree.hash !== input.mainHash)
      throw Error(
        "Files changed after this review. Refresh the review before transferring.",
      );
    if (input.resolutionPaths) {
      const error = await resolutionCheck(copy.tree, input.resolutionPaths);
      if (error) throw Error(error);
    }
    const base = await snapshot("/base/copy");
    const result = await mergeTrees(
      base.tree,
      copy.tree,
      main.tree,
      "/operation/merged-apply",
      input.choices,
    );
    if (
      result.changes.some(
        (c) => c.conflict && !["main", "copy"].includes(input.choices[c.path]),
      )
    )
      throw Error("Choose a version for every conflict first.");
    await fs.rm("/operation/prepared", { recursive: true, force: true });
    // Full checkpoint candidate: .git, ignored files and secrets stay in main.
    await snapshot("/main", "/operation/prepared", true);
    await overlay("/operation/prepared", main.tree, result.tree);
    return { transferred: result.changes.length };
  }
  throw Error("Unknown folder operation");
}
run()
  .then((r) => process.stdout.write(JSON.stringify(r)))
  .catch((e) => {
    process.stderr.write(e.message);
    process.exitCode = 1;
  });
