import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/web/diff";

describe("unified diff review", () => {
  it("counts changes and tracks both line numbers across hunks", () => {
    const [f] = parseDiff(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n@@ -20 +21 @@\n-before\n+after\n",
    );
    expect(f).toMatchObject({ path: "a.ts", added: 3, removed: 2 });
    expect(f.lines.filter((l) => l.kind !== "meta")).toEqual([
      { text: "same", kind: "context", old: 2, next: 2 },
      { text: "old", kind: "removed", old: 3 },
      { text: "new", kind: "added", next: 3 },
      { text: "extra", kind: "added", next: 4 },
      { text: "before", kind: "removed", old: 20 },
      { text: "after", kind: "added", next: 21 },
    ]);
  });
  it("handles new and deleted files without calling them /dev/null", () => {
    const files = parseDiff(
      "diff --git a/new b/new\n--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+hello\ndiff --git a/old b/old\n--- a/old\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\n",
    );
    expect(
      files.map(({ path, added, removed }) => ({ path, added, removed })),
    ).toEqual([
      { path: "new", added: 1, removed: 0 },
      { path: "old", added: 0, removed: 1 },
    ]);
  });
  it("decodes quoted UTF-8 paths and accepts spaces", () => {
    expect(
      parseDiff(
        'diff --git "a/\\321\\202.txt" "b/\\321\\202.txt"\n--- "a/\\321\\202.txt"\n+++ "b/\\321\\202.txt"\n',
      )[0].path,
    ).toBe("т.txt");
    expect(
      parseDiff(
        "diff --git a/my file.md b/my file.md\n--- a/my file.md\t\n+++ b/my file.md\t\n",
      )[0].path,
    ).toBe("my file.md");
  });
  it("keeps binary, rename and mode metadata visible", () => {
    const [f] = parseDiff(
      "diff --git a/old.png b/new.png\nsimilarity index 100%\nrename from old.png\nrename to new.png\nold mode 100644\nnew mode 100755\nBinary files a/old.png and b/new.png differ\n",
    );
    expect(f.path).toBe("new.png");
    expect(f.added + f.removed).toBe(0);
    expect(f.lines.map((l) => l.text)).toContain(
      "Binary files a/old.png and b/new.png differ",
    );
    expect(f.lines).toHaveLength(6);
  });
  it("does not mistake code resembling headers for file metadata", () => {
    const [f] = parseDiff(
      "diff --git a/test b/test\n@@ -1 +1 @@\n--- old\n+++ new\n\\ No newline at end of file\n",
    );
    expect(f).toMatchObject({ path: "test", added: 1, removed: 1 });
    expect(f.lines[1]).toMatchObject({ text: "-- old", old: 1 });
    expect(f.lines[2]).toMatchObject({ text: "++ new", next: 1 });
    expect(f.lines[3].kind).toBe("meta");
  });
  it("preserves unknown output for review and returns no files for empty output", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("unrecognized diff output")[0].lines[0].text).toBe(
      "unrecognized diff output",
    );
  });
});
