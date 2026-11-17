export type DiffLine = {
  text: string;
  kind: "context" | "added" | "removed" | "meta";
  old?: number;
  next?: number;
};
export type DiffFile = {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
};

// Git quotes special characters and UTF-8 bytes in paths unless core.quotePath is off.
function gitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, string> = {
    t: "\t",
    n: "\n",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    a: "\x07",
  };
  const body = value.slice(1, -1);
  for (let i = 0; i < body.length;) {
    if (body[i] === "\\") {
      const octal = body.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        i += octal.length + 1;
      } else {
        bytes.push(
          ...encoder.encode(escapes[body[i + 1]] ?? body[i + 1] ?? "\\"),
        );
        i += 2;
      }
    } else {
      const char = String.fromCodePoint(body.codePointAt(i)!);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let old = 0,
    next = 0,
    inHunk = false;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const text of lines) {
    if (text.startsWith("diff --git ")) {
      const header = text.slice(11);
      const destination = header.match(/ ("b\/.*"|b\/.*)$/)?.[1];
      file = {
        path: destination ? gitPath(destination).replace(/^b\//, "") : header,
        added: 0,
        removed: 0,
        lines: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) {
      if (!text.trim()) continue;
      file = { path: "Changes", added: 0, removed: 0, lines: [] };
      files.push(file);
    }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ text, kind: "meta" });
      continue;
    }
    if (!inHunk && (text.startsWith("+++ ") || text.startsWith("--- "))) {
      const path = gitPath(text.slice(4).replace(/\t$/, ""));
      if (path !== "/dev/null") file.path = path.replace(/^[ab]\//, "");
      continue;
    }
    if (inHunk && text.startsWith("+")) {
      file.added++;
      file.lines.push({ text: text.slice(1), kind: "added", next: next++ });
    } else if (inHunk && text.startsWith("-")) {
      file.removed++;
      file.lines.push({ text: text.slice(1), kind: "removed", old: old++ });
    } else if (inHunk && text.startsWith(" ")) {
      file.lines.push({
        text: text.slice(1),
        kind: "context",
        old: old++,
        next: next++,
      });
    } else {
      file.lines.push({ text, kind: "meta" });
    }
  }
  return files;
}
