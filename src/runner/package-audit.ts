import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  maxPackageRequestBytes,
  maxPackageRequests,
  packageAuditPath,
  packageNames,
} from "./package-request.js";

const maxAuditBytes = maxPackageRequests * maxPackageRequestBytes + 2;

let emitted = 0;
let previousSize = 0;
export function drainPackageAudit(): string[][] {
  try {
    const file = openSync(
      packageAuditPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = fstatSync(file);
      if (
        !info.isFile() ||
        info.size > maxAuditBytes ||
        info.size === previousSize
      )
        return [];
      const installed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(installed)) return [];
      const pending = installed.slice(emitted).map(packageNames);
      emitted = installed.length;
      previousSize = info.size;
      return pending.filter((names) => names !== null);
    } finally {
      closeSync(file);
    }
  } catch {
    return [];
  }
}
