export type GitCommand = (args: string[]) => Promise<string>;

// Call with an isolated index. The returned tree is the exact prospective commit.
export async function candidateTree(run: GitCommand) {
  const head = (await run(["rev-parse", "--verify", "HEAD"])).trim();
  await run(["read-tree", head]);
  await run([
    "add",
    "--all",
    "--",
    ".",
    ":!.workspace-attachments",
    ":!.workspace-folders",
  ]);
  const tree = (await run(["write-tree"])).trim();
  return { head, tree };
}

export const trustedDiffOptions = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--ignore-submodules=none",
  "--submodule=short",
  "--unified=3",
];

// Render in a fresh repository, with no workspace configuration or attributes.
export async function renderPublication(
  run: GitCommand,
  head: string,
  tree: string,
  baseline: string,
) {
  const diff = await run(["diff", ...trustedDiffOptions, head, tree, "--"]);
  const commits = await run([
    "log",
    "--format=%h %s",
    head,
    "--not",
    baseline,
    "--",
  ]);
  // Include every commit, including changes later reverted and merge parents.
  const pushDiff = await run([
    "log",
    "--format=",
    "--patch",
    "--root",
    "--diff-merges=separate",
    ...trustedDiffOptions,
    head,
    "--not",
    baseline,
    "--",
  ]);
  return { diff, pushDiff, commits };
}

export function requireReviewedState(
  actual: { head: string; tree: string },
  reviewed: { head: string; tree: string },
) {
  if (actual.head !== reviewed.head || actual.tree !== reviewed.tree)
    throw Object.assign(
      new Error(
        "Files or commits changed. Refresh and review the changes again.",
      ),
      { statusCode: 409 },
    );
}
