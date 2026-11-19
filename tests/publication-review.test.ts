import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  candidateTree,
  renderPublication,
  requireReviewedState,
} from "../src/server/publication-review";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "publication-review-"));
  roots.push(root);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@localhost",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@localhost",
  };
  const run = async (args: string[], extra = {}) =>
    (await exec("git", args, { cwd: root, env: { ...env, ...extra } })).stdout;
  await run(["init"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "original\n");
  await run(["add", "."]);
  await run(["commit", "-m", "base"]);
  const base = (await run(["rev-parse", "HEAD"])).trim();
  const candidate = () =>
    candidateTree((args) =>
      run(args, { GIT_INDEX_FILE: path.join(root, ".git", "review-index") }),
    );
  return { root, run, base, candidate };
}
describe("publication review", () => {
  it("reviews the prospective tree including new/binary files, preserves the real index, and rejects later edits", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "new.txt"), "new content\n");
    await fs.writeFile(path.join(f.root, "binary"), Buffer.from([0, 1, 2]));
    await fs.mkdir(path.join(f.root, ".workspace-attachments"));
    await fs.writeFile(
      path.join(f.root, ".workspace-attachments", "private"),
      "excluded",
    );
    const reviewed = await f.candidate();
    const rendered = await renderPublication(
      f.run,
      reviewed.head,
      reviewed.tree,
      f.base,
    );
    expect(rendered.diff).toContain("new content");
    expect(rendered.diff).toContain("Binary files");
    expect(rendered.diff).not.toContain("private");
    expect(await f.run(["diff", "--cached"])).toBe("");
    expect(() => requireReviewedState(reviewed, reviewed)).not.toThrow();
    await fs.writeFile(path.join(f.root, "new.txt"), "changed later\n");
    expect(() =>
      requireReviewedState({ ...reviewed, head: "different" }, reviewed),
    ).toThrow("Refresh");
    const changed = await f.candidate();
    expect(() => requireReviewedState(changed, reviewed)).toThrow("Refresh");
  });
  it("disables external diff and text conversion and shows reverted outgoing commits", async () => {
    const f = await fixture();
    await f.run(["config", "diff.external", "printf forged-preview"]);
    await f.run(["config", "diff.fake.textconv", "printf forged-preview"]);
    await fs.writeFile(
      path.join(f.root, ".gitattributes"),
      "*.txt diff=fake\n",
    );
    await fs.writeFile(
      path.join(f.root, "tracked.txt"),
      "review this content\n",
    );
    const state = await f.candidate();
    const rendered = await renderPublication(
      f.run,
      state.head,
      state.tree,
      f.base,
    );
    expect(rendered.diff).toContain("review this content");
    expect(rendered.diff).not.toContain("forged-preview");
    await f.run(["add", "."]);
    await f.run(["commit", "-m", "temporary change"]);
    await fs.writeFile(path.join(f.root, "tracked.txt"), "original\n");
    await f.run(["add", "."]);
    await f.run(["commit", "-m", "revert content"]);
    const outgoing = await f.candidate();
    const review = await renderPublication(
      f.run,
      outgoing.head,
      outgoing.tree,
      f.base,
    );
    expect(review.diff).toBe("");
    expect(review.commits).toContain("temporary change");
    expect(review.commits).toContain("revert content");
    expect(review.pushDiff).toContain("+review this content");
    expect(review.pushDiff).toContain("-review this content");
  });
});
