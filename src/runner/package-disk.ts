const MiB = 1024 * 1024;
export const packageRunBudget = 1024 * MiB;
export const packageIndexAllowance = 128 * MiB;
const filesystemReserve = 512 * MiB;

export type InstallMode = "run" | "preset";
export type PackageBudgets = Record<InstallMode, number> & {
  peerPreset?: number;
};

function budgetBytes(value: string | undefined, fallback: number) {
  if (value === undefined || !/^\d+$/.test(value)) return fallback;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : fallback;
}

export function packageBudgets(
  env: NodeJS.ProcessEnv,
  presetDefault = packageRunBudget,
): PackageBudgets {
  const preset = budgetBytes(
    env.WORKSPACE_PACKAGE_PRESET_BUDGET,
    presetDefault,
  );
  return {
    run: budgetBytes(env.WORKSPACE_PACKAGE_RUN_BUDGET, packageRunBudget),
    preset,
    ...(env.WORKSPACE_PACKAGE_PEER_PRESET_BUDGET && {
      peerPreset: budgetBytes(env.WORKSPACE_PACKAGE_PEER_PRESET_BUDGET, preset),
    }),
  };
}

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
  budgets: PackageBudgets = { run: packageRunBudget, preset: packageRunBudget },
  mode: InstallMode = "run",
): string | undefined {
  const budget = budgets[mode];
  if (requested > budget - used) {
    const label = mode === "run" ? "run" : "preset";
    const size = budget === packageRunBudget ? "1 GiB" : `${budget} bytes`;
    return `This installation would exceed the ${size} system-package budget for this ${label}.`;
  }
  if (!requested) return;
  const peerBudget =
    BigInt(budgets.run) +
    BigInt(mode === "preset" ? (budgets.peerPreset ?? budgets.preset) : 0);
  const reserve =
    BigInt(filesystemReserve) + BigInt(concurrency - 1) * peerBudget;
  if (available < reserve + BigInt(requested))
    return "Not enough space on the Docker disk to install system packages and keep space available for other tasks.";
}
