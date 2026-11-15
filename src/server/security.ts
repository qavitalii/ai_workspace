import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
export function seal(s: string) {
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", Buffer.from(config.key, "hex"), iv);
  return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]).toString(
    "base64",
  );
}
export function unseal(s: string) {
  const b = Buffer.from(s, "base64"),
    c = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(config.key, "hex"),
      b.subarray(0, 12),
    );
  c.setAuthTag(b.subarray(-16));
  return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function safeName(s: string) {
  return (
    path
      .basename(s.replaceAll("\\", "/"))
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 180) || "file"
  );
}
export async function confined(root: string, relative: string) {
  if (
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === ".." || p === ".git")
  )
    throw new Error("Invalid path");
  const base = await realpath(root),
    dest = await realpath(path.resolve(root, relative));
  if (dest !== base && !dest.startsWith(base + path.sep))
    throw new Error("Path leaves workspace");
  if ((await lstat(dest)).isSymbolicLink())
    throw new Error("Symbolic links are not supported");
  return dest;
}
export function redact(text: string) {
  return text.replace(
    /(?:sk-(?:ant-)?[\w-]{10,}|gh[pousr]_[\w]{15,}|github_pat_[\w]{15,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g,
    "[REDACTED]",
  );
}
