// Executed only in the unprivileged, offline folder helper (or temporary test directories).
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type Node = {
  kind: "file" | "link" | "dir";
  hash: string;
  mode?: number;
  target?: string;
  children?: Record<string, Node>;
  source: string;
};
export type Snapshot = { tree: Node; excluded: string[] };
export type Change = {
  path: string;
  status: string;
  conflict: boolean;
  main: string | null;
  copy: string | null;
  result?: string | null;
  children?: Change[];
};
const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
const skip = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".ssh",
  ".aws",
  ".gnupg",
  "id_rsa",
  "id_ed25519",
  ".envrc",
]);
export function excluded(name: string) {
  return (
    skip.has(name) ||
    name.startsWith(".workspace-") ||
    (/^\.env(?:\.|$)/.test(name) && !/\.(example|sample|template)$/.test(name))
  );
}
export async function snapshot(
  root: string,
  dest?: string,
  all = false,
): Promise<Snapshot> {
  let count = 0,
    bytes = 0;
  const ignored: string[] = [];
  async function walk(rel: string): Promise<Node> {
    const source = path.join(root, rel),
      st = await fs.lstat(source);
    if (++count > 50000)
      throw Error(
        "Folder has more than 50,000 entries. Reduce its size first.",
      );
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(source);
      if (dest) await fs.symlink(target, path.join(dest, rel));
      return {
        kind: "link",
        hash: hash("link:" + target),
        target,
        source: dest ? path.join(dest, rel) : source,
      };
    }
    if (st.isDirectory()) {
      if (dest) await fs.mkdir(path.join(dest, rel), { recursive: true });
      const children: Record<string, Node> = Object.create(null);
      for (const name of (await fs.readdir(source)).sort()) {
        const next = path.join(rel, name);
        if (!all && excluded(name)) {
          ignored.push(next);
          continue;
        }
        children[name] = await walk(next);
      }
      return {
        kind: "dir",
        children,
        hash: hash(
          JSON.stringify(Object.entries(children).map(([k, n]) => [k, n.hash])),
        ),
        source: dest ? path.join(dest, rel) : source,
      };
    }
    if (!st.isFile()) throw Error("Unsupported special file: " + rel);
    bytes += st.size;
    if (st.size > 100 * 1024 ** 2 || bytes > 2 * 1024 ** 3)
      throw Error(
        "Folder copy limit exceeded (100 MB per file, 2 GB total): " + rel,
      );
    const content = await fs.readFile(source),
      mode = st.mode & 0o777;
    if (dest) {
      await fs.writeFile(path.join(dest, rel), content);
      await fs.chmod(path.join(dest, rel), mode);
    }
    return {
      kind: "file",
      hash: hash(Buffer.concat([Buffer.from("file:" + mode + ":"), content])),
      mode,
      source: dest ? path.join(dest, rel) : source,
    };
  }
  return { tree: await walk(""), excluded: ignored };
}
export async function preview(n?: Node): Promise<string | null> {
  if (!n) return "(absent)";
  if (n.kind === "link") return "Symbolic link → " + n.target;
  if (n.kind === "dir")
    return "Folder (" + Object.keys(n.children!).length + " entries)";
  const st = await fs.stat(n.source);
  if (st.size > 128000) return null;
  const b = await fs.readFile(n.source),
    s = b.toString("utf8");
  return b.includes(0) || !Buffer.from(s).equals(b) ? null : s;
}
export async function mergeTrees(
  base: Node,
  copy: Node,
  main: Node,
  scratch: string,
  choices: Record<string, "main" | "copy"> = {},
) {
  const changes: Change[] = [];
  let serial = 0;
  await fs.mkdir(scratch, { recursive: true });
  const same = (a?: Node, b?: Node) => a?.hash === b?.hash;
  async function descendants(m?: Node, c?: Node, rel = ""): Promise<Change[]> {
    const entries: Change[] = [];
    const names = new Set([
      ...Object.keys(m?.children || {}),
      ...Object.keys(c?.children || {}),
    ]);
    for (const name of [...names].sort()) {
      const before = m?.children?.[name],
        after = c?.children?.[name];
      if (same(before, after)) continue;
      const childPath = path.join(rel, name);
      entries.push({
        path: childPath,
        status: !before ? "added" : !after ? "deleted" : "modified",
        conflict: false,
        main: await preview(before),
        copy: await preview(after),
        result: await preview(after),
      });
      entries.push(...(await descendants(before, after, childPath)));
    }
    return entries;
  }
  async function merge(
    b: Node | undefined,
    c: Node | undefined,
    m: Node | undefined,
    rel: string,
  ): Promise<Node | undefined> {
    if (same(b, c)) return m;
    if (c?.kind === "dir" && m?.kind === "dir" && (!b || b.kind === "dir")) {
      const children: Record<string, Node> = Object.create(null);
      const names = new Set([
        ...Object.keys(b?.children || {}),
        ...Object.keys(c.children!),
        ...Object.keys(m.children!),
      ]);
      for (const name of [...names].sort()) {
        const node = await merge(
          b?.children?.[name],
          c.children![name],
          m.children![name],
          path.join(rel, name),
        );
        if (node) children[name] = node;
      }
      return {
        kind: "dir",
        children,
        hash: hash(
          JSON.stringify(Object.entries(children).map(([k, n]) => [k, n.hash])),
        ),
        source: m.source,
      };
    }
    let result = c,
      conflict = !same(m, b) && !same(m, c);
    if (
      conflict &&
      b?.kind === "file" &&
      c?.kind === "file" &&
      m?.kind === "file" &&
      (c.mode === b.mode || m.mode === b.mode || c.mode === m.mode)
    ) {
      const texts = await Promise.all([preview(b), preview(c), preview(m)]);
      if (texts.every((t) => t !== null)) {
        try {
          const { stdout } = await exec(
            "git",
            ["merge-file", "-p", "--", m.source, b.source, c.source],
            {
              maxBuffer: 1000000,
              env: {
                ...process.env,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
            },
          );
          const source = path.join(scratch, String(serial++)),
            mode = c.mode !== b.mode ? c.mode : m.mode;
          await fs.writeFile(source, stdout);
          await fs.chmod(source, mode!);
          result = {
            kind: "file",
            hash: hash(
              Buffer.concat([
                Buffer.from("file:" + mode + ":"),
                Buffer.from(stdout),
              ]),
            ),
            mode,
            source,
          };
          conflict = false;
        } catch (e: any) {
          if (typeof e.code !== "number" || e.code < 1 || e.code > 127) throw e;
        }
      }
    }
    if (conflict) result = choices[rel] === "copy" ? c : m;
    changes.push({
      path: rel,
      status: !b ? "added" : !c ? "deleted" : "modified",
      conflict,
      main: await preview(m),
      copy: await preview(c),
      result: conflict ? undefined : await preview(result),
      children: await descendants(m, c, rel),
    });
    return result;
  }
  const tree = (await merge(base, copy, main, ""))!;
  return { tree, changes };
}
// Only touch reviewed entries. Excluded files (including secrets/build outputs) are
// retained, even inside a deleted directory. Replacing such a directory fails safely.
export async function overlay(
  target: string,
  before: Node | undefined,
  after: Node | undefined,
) {
  if (before?.hash === after?.hash) return;
  if (before?.kind === "dir" && after?.kind === "dir") {
    for (const name of new Set([
      ...Object.keys(before.children!),
      ...Object.keys(after.children!),
    ]))
      await overlay(
        path.join(target, name),
        before.children![name],
        after.children![name],
      );
    return;
  }
  if (before?.kind === "dir") {
    for (const [name, node] of Object.entries(before.children!))
      await overlay(path.join(target, name), node, undefined);
    try {
      await fs.rmdir(target);
    } catch (e: any) {
      if (e.code !== "ENOTEMPTY" || after) throw e;
    }
  } else if (before) await fs.unlink(target);
  if (!after) return;
  if (after.kind === "dir") {
    await fs.mkdir(target, { recursive: false });
    for (const [name, node] of Object.entries(after.children!))
      await overlay(path.join(target, name), undefined, node);
  } else if (after.kind === "link") await fs.symlink(after.target!, target);
  else {
    await fs.copyFile(after.source, target, fs.constants.COPYFILE_EXCL);
    await fs.chmod(target, after.mode!);
  }
}
