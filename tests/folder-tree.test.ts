import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshot, mergeTrees, overlay } from "../src/server/folder-tree";
let roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "copy-tree-"));
  roots.push(root);
  for (const d of ["base", "copy", "main", "out"])
    await fs.mkdir(path.join(root, d));
  return root;
}
afterEach(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
  roots = [];
});
describe("working copy file comparison", () => {
  it("includes untracked and binary files, excludes local configuration, and never follows links", async () => {
    const r = await fixture();
    await fs.writeFile(r + "/main/report.pdf", Buffer.from([0, 1, 2]));
    await fs.writeFile(r + "/main/.env", "secret");
    await fs.writeFile(r + "/main/.env.example", "example");
    await fs.mkdir(r + "/main/node_modules");
    await fs.writeFile(r + "/main/node_modules/dependency", "deps");
    await fs.symlink("/etc/passwd", r + "/main/external");
    const s = await snapshot(r + "/main", r + "/out");
    expect(s.excluded).toEqual([".env", "node_modules"]);
    expect(await fs.readFile(r + "/out/report.pdf")).toEqual(
      Buffer.from([0, 1, 2]),
    );
    expect(await fs.readlink(r + "/out/external")).toBe("/etc/passwd");
    expect(await fs.readFile(r + "/out/.env.example", "utf8")).toBe("example");
  });
  it("combines non-overlapping text edits and keeps main-only additions", async () => {
    const r = await fixture(),
      base = "one\ntwo\nthree\nfour\nfive\nsix\n";
    await fs.writeFile(r + "/base/a", base);
    await fs.writeFile(r + "/copy/a", base.replace("one", "ONE"));
    await fs.writeFile(r + "/main/a", base.replace("six", "SIX"));
    await fs.writeFile(r + "/main/new", "main only");
    const [b, c, m] = await Promise.all(
      ["base", "copy", "main"].map((x) => snapshot(r + "/" + x)),
    );
    const result = await mergeTrees(b.tree, c.tree, m.tree, r + "/merge");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].conflict).toBe(false);
    expect(result.changes[0].result).toBe(
      base.replace("one", "ONE").replace("six", "SIX"),
    );
    expect(result.tree.children!.new).toBeDefined();
  });
  it("requires choices for binary, deletion and structural conflicts", async () => {
    const r = await fixture();
    for (const d of ["base", "copy", "main"])
      await fs.writeFile(
        r + "/" + d + "/binary",
        Buffer.from([0, d.length, d.charCodeAt(0)]),
      );
    await fs.writeFile(r + "/base/deleted", "old");
    await fs.writeFile(r + "/main/deleted", "edited");
    await fs.writeFile(r + "/base/shape", "old");
    await fs.mkdir(r + "/copy/shape");
    await fs.writeFile(r + "/copy/shape/nested", "copy");
    await fs.writeFile(r + "/main/shape", "main");
    const [b, c, m] = await Promise.all(
      ["base", "copy", "main"].map((x) => snapshot(r + "/" + x)),
    );
    const result = await mergeTrees(b.tree, c.tree, m.tree, r + "/merge", {
      binary: "copy",
      deleted: "main",
      shape: "copy",
    });
    expect(result.changes.filter((x) => x.conflict)).toHaveLength(3);
    expect(result.changes.find((x) => x.path === "shape")?.children).toEqual([
      expect.objectContaining({
        path: "shape/nested",
        status: "added",
        copy: "copy",
      }),
    ]);
    await overlay(r + "/main", m.tree, result.tree);
    expect(await fs.readFile(r + "/main/deleted", "utf8")).toBe("edited");
    expect(await fs.readFile(r + "/main/shape/nested", "utf8")).toBe("copy");
    expect(await fs.readFile(r + "/main/binary")).toEqual(
      await fs.readFile(r + "/copy/binary"),
    );
  });
  it("preserves excluded files inside deleted directories and refuses to overwrite them", async () => {
    const r = await fixture();
    for (const d of ["base", "main"]) {
      await fs.mkdir(r + "/" + d + "/dir");
      await fs.writeFile(r + "/" + d + "/dir/file", "old");
    }
    await fs.writeFile(r + "/main/dir/.env", "keep");
    const [b, c, m] = await Promise.all(
      ["base", "copy", "main"].map((x) => snapshot(r + "/" + x)),
    );
    const result = await mergeTrees(b.tree, c.tree, m.tree, r + "/merge");
    expect(result.changes.find((x) => x.path === "dir")?.children).toEqual([
      expect.objectContaining({
        path: "dir/file",
        status: "deleted",
        main: "old",
        copy: "(absent)",
      }),
    ]);
    await overlay(r + "/main", m.tree, result.tree);
    expect(await fs.readFile(r + "/main/dir/.env", "utf8")).toBe("keep");
    await fs.writeFile(r + "/copy/dir", "replacement");
    const m2 = await snapshot(r + "/main"),
      c2 = await snapshot(r + "/copy");
    const result2 = await mergeTrees(b.tree, c2.tree, m2.tree, r + "/merge2", {
      dir: "copy",
    });
    await expect(overlay(r + "/main", m2.tree, result2.tree)).rejects.toThrow();
    expect(await fs.readFile(r + "/main/dir/.env", "utf8")).toBe("keep");
  });
  it("tracks executable permissions and empty folders", async () => {
    const r = await fixture();
    for (const d of ["base", "copy", "main"]) {
      await fs.writeFile(r + "/" + d + "/run", "hi");
      await fs.chmod(r + "/" + d + "/run", 0o644);
    }
    await fs.chmod(r + "/copy/run", 0o755);
    await fs.mkdir(r + "/copy/empty");
    const [b, c, m] = await Promise.all(
      ["base", "copy", "main"].map((x) => snapshot(r + "/" + x)),
    );
    const result = await mergeTrees(b.tree, c.tree, m.tree, r + "/merge");
    await overlay(r + "/main", m.tree, result.tree);
    expect((await fs.stat(r + "/main/run")).mode & 0o777).toBe(0o755);
    expect((await fs.stat(r + "/main/empty")).isDirectory()).toBe(true);
  });
  it("shows every descendant of added directories including binary files", async () => {
    const r = await fixture();
    await fs.mkdir(r + "/copy/notes/nested", { recursive: true });
    await fs.writeFile(r + "/copy/notes/nested/new.txt", "review me");
    await fs.writeFile(r + "/copy/notes/binary", Buffer.from([0, 1]));
    const [b, c, m] = await Promise.all(
      ["base", "copy", "main"].map((d) => snapshot(r + "/" + d)),
    );
    const result = await mergeTrees(b.tree, c.tree, m.tree, r + "/merge");
    expect(result.changes[0].children).toEqual([
      expect.objectContaining({ path: "notes/binary", copy: null }),
      expect.objectContaining({ path: "notes/nested", status: "added" }),
      expect.objectContaining({
        path: "notes/nested/new.txt",
        copy: "review me",
      }),
    ]);
    await overlay(r + "/main", m.tree, result.tree);
    expect(await fs.readFile(r + "/main/notes/nested/new.txt", "utf8")).toBe(
      "review me",
    );
  });
});
