import { requestPackages } from "./package-client.js";
import {
  projectPackageNames,
  packagePresetResults,
  packagePresetSocket,
  packagePresetTimeout,
  type PackagePresetResult,
} from "./package-request.js";

const results: PackagePresetResult[] = [];
const skips = new Map<string, string[]>();
const missingReason = "The package installer returned no reason.";
const presetBatchSize = 64;

function recordSkip(output: unknown, names: string[]) {
  const reason = typeof output === "string" && output ? output : missingReason;
  const previous = skips.get(reason);
  if (previous) previous.push(...names);
  else skips.set(reason, names);
}

// One deadline for the entire list, including later batches.
const signal = AbortSignal.timeout(packagePresetTimeout + 5_000);
let incomplete = false;
let pending: string[] = [];
try {
  const names = projectPackageNames(
    JSON.parse(process.env.WORKSPACE_PROJECT_PACKAGES ?? "null"),
  );
  if (!names) throw new Error("Invalid project package list.");
  pending = names;
  while (pending.length) {
    const batch = pending.slice(0, presetBatchSize);
    const reply = (await requestPackages(
      packagePresetSocket,
      batch,
      signal,
    )) as {
      results?: { skipped?: boolean; output?: string }[];
      incomplete?: boolean;
      output?: string;
    } | null;
    const reported = packagePresetResults(reply?.results);
    if (
      reported?.length !== batch.length ||
      !reported.every(({ name }, index) => name === batch[index])
    )
      throw new Error("Invalid project package results.");
    for (const [index, result] of reported.entries()) {
      const raw = reply?.results?.[index];
      if (raw?.skipped) recordSkip(raw.output, [result.name]);
      else results.push(result);
    }
    pending = pending.slice(batch.length);
    if (reply?.incomplete) {
      incomplete = true;
      if (pending.length) recordSkip(reply.output, pending);
      break;
    }
  }
} catch (error) {
  incomplete = true;
  const reason = signal.aborted
    ? "Package installation timed out."
    : error instanceof Error
      ? error.message
      : "The package installer closed without a valid result.";
  recordSkip(reason, pending);
}
const skipLog = [...skips].map(([reason, names]) =>
  names.length ? `${reason}\nPackages: ${names.join(", ")}` : reason,
);
process.stdout.write(JSON.stringify({ results, incomplete, skipLog }));
