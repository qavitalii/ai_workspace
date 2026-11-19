const MiB = 1024 * 1024;
export const packageRunBudget = 1024 * MiB;
export const packageIndexAllowance = 128 * MiB;
const filesystemReserve = 512 * MiB;

type PlannedPackage = {
  name: string;
  argument: string;
  version: string;
  architecture: string;
};

export function parseInstallPlan(lines: string[]): PlannedPackage[] | null {
  const changes = new Map<string, PlannedPackage>();
  let count: number | undefined;
  for (const line of lines) {
    const summary =
      /^(\d+) upgraded, (\d+) newly installed, (\d+) to remove/.exec(line);
    if (summary) {
      if (Number(summary[3]) !== 0) return null;
      count = Number(summary[1]) + Number(summary[2]);
    }
    if (!line.startsWith("Inst ")) continue;
    // APT's simulation reports the selected version and architecture, including
    // an optional old version when the installation upgrades a dependency.
    const operation =
      /^Inst (([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9-]+)?) (?:\[[^\]]*\] )?\(([0-9][0-9A-Za-z.+:~\-]*) .* \[([a-z0-9-]+)\]\)(?: \[.*\])?$/.exec(
        line,
      );
    if (!operation || changes.size >= 4096) return null;
    const [, argument, name, version, architecture] = operation;
    changes.set(`${name}:${architecture}=${version}`, {
      name,
      argument: `${argument}=${version}`,
      version,
      architecture,
    });
  }
  return count === changes.size ? [...changes.values()] : null;
}

export function estimateInstallBytes(
  plan: PlannedPackage[],
  lines: string[],
): number | null {
  const packages = new Map<string, number>();
  let record: Record<string, string> = {};
  function addRecord() {
    const size = Number(record.Size);
    const installed = Number(record["Installed-Size"]);
    if (
      record.Package &&
      record.Architecture &&
      record.Version &&
      Number.isSafeInteger(size) &&
      Number.isSafeInteger(installed) &&
      size > 0 &&
      installed >= 0
    ) {
      const key = `${record.Package}:${record.Architecture}=${record.Version}`;
      // Charge the entire new payload for upgrades as well, since overlayfs
      // retains the base image and may copy existing files into the new layer.
      const bytes = size + installed * 1024;
      if (Number.isSafeInteger(bytes))
        packages.set(key, Math.max(bytes, packages.get(key) ?? 0));
    }
    record = {};
  }
  for (const line of lines) {
    if (!line) {
      addRecord();
      continue;
    }
    const field =
      /^(Package|Architecture|Version|Size|Installed-Size): (.+)$/.exec(line);
    if (field) record[field[1]] = field[2];
  }
  addRecord();
  let bytes = 0;
  for (const { name, architecture, version } of plan) {
    const size = packages.get(`${name}:${architecture}=${version}`);
    if (size === undefined) return null;
    bytes += size;
    if (!Number.isSafeInteger(bytes)) return null;
  }
  // Debian's estimates exclude some package metadata and temporary files.
  const estimated = bytes ? Math.ceil(bytes * 1.1) + 16 * MiB : 0;
  return Number.isSafeInteger(estimated) ? estimated : null;
}

export function diskLimitError(
  used: number,
  requested: number,
  available: bigint,
  concurrency: number,
): string | undefined {
  if (used + requested > packageRunBudget)
    return "This installation would exceed the 1 GiB system-package budget for this run.";
  if (!requested) return;
  const reserve =
    BigInt(filesystemReserve) +
    BigInt(concurrency - 1) * BigInt(packageRunBudget);
  if (available < reserve + BigInt(requested))
    return "Not enough space on the Docker disk to install system packages and keep space available for other tasks.";
}
