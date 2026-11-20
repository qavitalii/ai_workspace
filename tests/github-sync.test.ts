import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { applyGithubUpdate } from "../src/server/github-sync.js";

const exec = promisify(execFile);
const directories: string[] = [];
const localBranch = "workspace/test";

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(publishedPath = "published.txt") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "workspace-github-sync-"),
  );
  directories.push(directory);
  async function run(args: string[]) {
    try {
      return (
        await exec(
          "git",
          [
            "-c",
            "user.name=Workspace",
            "-c",
            "user.email=workspace@localhost",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        )
      ).stdout;
    } catch (error: any) {
      throw Object.assign(new Error(error.stderr || error.message), {
        gitExitCode: error.code,
      });
    }
  }
  const write = (name: string, data: string) =>
    writeFile(path.join(directory, name), data);
  const read = (name: string) => readFile(path.join(directory, name), "utf8");
  const head = async () => (await run(["rev-parse", "HEAD"])).trim();
  await run(["init", "-b", "main"]);
  await write("shared.txt", "starting point\n");
  await write(".gitignore", "local.env\ncache/\n");
  await run(["add", "."]);
  await run(["commit", "-m", "Initial version"]);
  await run(["branch", localBranch]);
  await write(publishedPath, "from GitHub\n");
  await run(["add", "-f", publishedPath]);
  await run(["commit", "-m", "Upstream change"]);
  const incoming = await head();
  await run(["switch", localBranch]);
  return {
    directory,
    run,
    write,
    read,
    head,
    incoming,
    sync: () => applyGithubUpdate(run, localBranch, "main", incoming),
  };
}

describe("syncing an existing Workspace Git branch", () => {
  it("fast-forwards and preserves unrelated ignored files, then reports up to date", async () => {
    const git = await fixture();
    await git.write("local.env", "local data\n");
    expect(await git.sync()).toEqual({
      status: "updated",
      sourceBranch: "main",
      commit: git.incoming,
    });
    expect(await git.read("local.env")).toBe("local data\n");
    expect(await git.read("published.txt")).toBe("from GitHub\n");
    expect(await git.sync()).toMatchObject({
      status: "current",
      commit: git.incoming,
    });
  });

  it("merges upstream into a worktree branch with its own committed changes", async () => {
    const git = await fixture();
    const worktree = path.join(
      git.directory,
      "..",
      path.basename(git.directory) + "-copy",
    );
    directories.push(worktree);
    await git.run(["switch", "main"]);
    await git.run(["worktree", "add", worktree, localBranch]);
    const fromCopy = (args: string[]) => git.run(["-C", worktree, ...args]);
    await writeFile(path.join(worktree, "draft.txt"), "local commit\n");
    await fromCopy(["add", "draft.txt"]);
    await fromCopy(["commit", "-m", "Working copy starting snapshot"]);
    const local = (await fromCopy(["rev-parse", "HEAD"])).trim();
    const result = await applyGithubUpdate(
      fromCopy,
      localBranch,
      "main",
      git.incoming,
    );
    expect(result.status).toBe("updated");
    expect(
      (await fromCopy(["rev-list", "--parents", "-n1", "HEAD"])).trim(),
    ).toBe(`${result.commit} ${local} ${git.incoming}`);
    expect(await readFile(path.join(worktree, "draft.txt"), "utf8")).toBe(
      "local commit\n",
    );
    expect(await readFile(path.join(worktree, "published.txt"), "utf8")).toBe(
      "from GitHub\n",
    );
    expect(await git.head()).toBe(git.incoming);
  });

  it.each(["staged", "unstaged", "untracked"])(
    "blocks %s edits before updating any files",
    async (kind) => {
      const git = await fixture();
      const edited = kind === "untracked" ? "new.txt" : "shared.txt";
      await git.write(edited, "local draft\n");
      if (kind === "staged") await git.run(["add", edited]);
      const before = await git.head();
      const status = await git.run(["status", "--porcelain"]);
      await expect(git.sync()).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("uncommitted changes"),
      });
      expect(await git.head()).toBe(before);
      expect(await git.run(["status", "--porcelain"])).toBe(status);
      expect(await git.read(edited)).toBe("local draft\n");
    },
  );

  it("leaves local commits intact when GitHub changes conflict", async () => {
    const git = await fixture("shared.txt");
    await git.write("shared.txt", "local change\n");
    await git.run(["commit", "-am", "Local change"]);
    const before = await git.head();
    await expect(git.sync()).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("conflict"),
    });
    expect(await git.head()).toBe(before);
    expect(await git.run(["status", "--porcelain"])).toBe("");
    expect(await git.read("shared.txt")).toBe("local change\n");
  });

  it.each(["local.env", "cache"])(
    "preserves ignored files when upstream would replace %s",
    async (collision) => {
      const git = await fixture(collision);
      const localFile =
        collision === "cache" ? "cache/important.txt" : collision;
      if (collision === "cache") await mkdir(path.join(git.directory, "cache"));
      await git.write(localFile, "private local contents\n");
      const before = await git.head();
      await expect(git.sync()).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("replace local files"),
      });
      expect(await git.head()).toBe(before);
      expect(await git.read(localFile)).toBe("private local contents\n");
    },
  );

  it("blocks a sync on a different branch", async () => {
    const git = await fixture();
    await git.run(["switch", "-c", "another-branch"]);
    const before = await git.head();
    await expect(git.sync()).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Switch back"),
    });
    expect(await git.head()).toBe(before);
  });
});
