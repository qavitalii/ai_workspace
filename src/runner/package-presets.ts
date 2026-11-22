import { requestPackages } from "./package-client.js";
import {
  maxPackageNames,
  projectPackageNames,
  packagePresetResults,
  packagePresetSocket,
  packagePresetTimeout,
  type PackagePresetResult,
} from "./package-request.js";

const results: PackagePresetResult[] = [];
let incomplete = false;
try {
  const names = projectPackageNames(
    JSON.parse(process.env.WORKSPACE_PROJECT_PACKAGES ?? "null"),
  );
  if (!names) throw new Error("Invalid project package list.");
  // One deadline for the entire list, including later batches.
  const signal = AbortSignal.timeout(packagePresetTimeout + 5_000);
  for (let start = 0; start < names.length; start += maxPackageNames) {
    const batch = names.slice(start, start + maxPackageNames);
    const reply = (await requestPackages(
      packagePresetSocket,
      batch,
      signal,
    )) as {
      results?: { skipped?: boolean }[];
      incomplete?: boolean;
    } | null;
    const reported = packagePresetResults(reply?.results);
    if (
      reported?.length !== batch.length ||
      !reported.every(({ name }, index) => name === batch[index])
    )
      throw new Error("Invalid project package results.");
    results.push(
      ...reported.filter((_, index) => !reply?.results?.[index].skipped),
    );
    if (reply?.incomplete) {
      incomplete = true;
      break;
    }
  }
} catch {
  incomplete = true;
}
process.stdout.write(JSON.stringify({ results, incomplete }));
