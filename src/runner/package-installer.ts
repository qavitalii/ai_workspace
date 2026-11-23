import {
  diskLimitError,
  estimateInstallBytes,
  packageIndexAllowance,
  parseInstallPlan,
  type InstallMode,
  type PackageBudgets,
} from "./package-disk.js";
import { maxPackageRequests, packagePresetTimeout } from "./package-request.js";

type InstallResult = {
  ok: boolean;
  output: string;
  skip?: "space" | "startup";
};
type AptResult = InstallResult & {
  interrupted?: boolean;
  dpkgStarted?: boolean;
  dpkgFailed?: boolean;
};
export type RunApt = (
  command: "apt-get" | "apt-cache",
  args: string[],
  deadline: number,
  signal: AbortSignal,
  onLine?: (line: string) => void,
  trackDpkg?: boolean,
) => Promise<AptResult>;

const cancelled: InstallResult = {
  ok: false,
  output: "Package installation was cancelled.",
  skip: "startup",
};
const timedOut: InstallResult = {
  ok: false,
  output: "Package installation timed out.",
  skip: "startup",
};
const couldNotStart: InstallResult = {
  ok: false,
  output: "The package installer could not start Debian apt.",
  skip: "startup",
};
const incompleteInstall =
  "A package installation did not finish cleanly. Start a new run to retry.";
const maxPresetPackageOutput = 1024;

export function packageFailure(
  mode: InstallMode,
  names: string[],
  output: string,
) {
  const presetOutput = output.slice(0, maxPresetPackageOutput);
  return {
    ok: false,
    output: mode === "preset" ? presetOutput : output,
    ...(mode === "preset" && {
      incomplete: true,
      results: names.map((name) => ({
        name,
        ok: false,
        skipped: true,
        output: presetOutput,
      })),
    }),
  };
}

export function createPackageInstaller({
  apt,
  availableBytes,
  recordInstalled,
  concurrency,
  budgets,
}: {
  apt: RunApt;
  availableBytes: () => Promise<bigint>;
  recordInstalled: (names: string[][]) => void;
  concurrency: number;
  budgets: PackageBudgets;
}) {
  let refreshed = false;
  let presetDeadline: number | undefined;
  let unavailable = "";
  const chargedBytes = { run: 0, preset: 0 };
  const installed: string[][] = [];

  async function checkDisk(mode: InstallMode, requested: number) {
    try {
      return diskLimitError(
        chargedBytes[mode],
        requested,
        await availableBytes(),
        concurrency,
        budgets,
        mode,
      );
    } catch {
      return "Could not verify available space on the Docker disk.";
    }
  }

  function runApt(mode: InstallMode): RunApt {
    return async (...args) => {
      const result = await apt(...args);
      if (mode === "run" && result.interrupted)
        unavailable = result.output + " Start a new run to retry.";
      if (mode === "preset" && result.dpkgFailed)
        unavailable = incompleteInstall;
      return result;
    };
  }

  async function refreshIndex(
    mode: InstallMode,
    apt: RunApt,
    deadline: number,
    signal: AbortSignal,
  ) {
    const error = await checkDisk(mode, packageIndexAllowance);
    if (error) return { ok: false, output: error };
    const result = await apt(
      "apt-get",
      ["-q", "update", "--error-on=any"],
      deadline,
      signal,
    );
    if (result.ok) {
      refreshed = true;
      chargedBytes[mode] += packageIndexAllowance;
    }
    return result;
  }

  async function install(
    names: string[],
    mode: InstallMode,
    apt: RunApt,
    deadline: number,
    signal: AbortSignal,
  ): Promise<InstallResult> {
    if (unavailable) return { ok: false, output: unavailable };
    if (signal.aborted) return cancelled;
    if (Date.now() >= deadline) return timedOut;
    // APT can also match foreign-architecture placeholders without an
    // installable version when a dependency mentions the same package name.
    const patterns = names.map(
      (name) => `?and(?exact-name(${name}),?not(?virtual))`,
    );
    const found = new Set<string>();
    const checked = await apt(
      "apt-cache",
      ["show", "--no-all-versions", "--", ...patterns],
      deadline,
      signal,
      (line) => {
        if (line.startsWith("Package: "))
          found.add(line.slice("Package: ".length));
      },
    );
    if (signal.aborted || checked.interrupted || checked.skip) return checked;
    const missing = names.filter((name) => !found.has(name));
    if (missing.length)
      return {
        ok: false,
        output:
          "No Debian package found with exact name: " + missing.join(", "),
      };
    if (!checked.ok) return checked;
    const installArguments = [
      "-q",
      "install",
      "-y",
      "--no-install-recommends",
      "--no-remove",
      "--",
      ...patterns,
    ];
    const planLines: string[] = [];
    const simulated = await apt(
      "apt-get",
      ["--simulate", ...installArguments],
      deadline,
      signal,
      (line) => {
        if (
          (line.startsWith("Inst ") || /^\d+ upgraded,/.test(line)) &&
          planLines.length <= 4097
        )
          planLines.push(line);
      },
    );
    if (!simulated.ok) return simulated;
    const plan = parseInstallPlan(planLines);
    const unknownSize = {
      ok: false,
      output:
        "Could not verify the disk size of every Debian package in this request.",
    };
    if (!plan) return unknownSize;
    const metadata: string[] = [];
    if (plan.length) {
      const details = await apt(
        "apt-cache",
        [
          "show",
          "--no-all-versions",
          "--",
          ...plan.map(({ argument }) => argument),
        ],
        deadline,
        signal,
        (line) => {
          if (
            !line ||
            /^(Package|Architecture|Version|Size|Installed-Size): /.test(line)
          )
            metadata.push(line);
        },
      );
      if (!details.ok) return details;
    }
    const estimated = estimateInstallBytes(plan, metadata);
    if (estimated === null) return unknownSize;
    const error = await checkDisk(mode, estimated);
    if (error) return { ok: false, output: error, skip: "space" };
    if (signal.aborted) return cancelled;
    if (Date.now() >= deadline) return timedOut;
    chargedBytes[mode] += estimated;
    const result = await apt(
      "apt-get",
      installArguments,
      deadline,
      signal,
      undefined,
      mode === "preset",
    );
    // A failed or interrupted dpkg invocation can leave half-configured packages.
    // Preset download and metadata failures can be retried without disabling apt.
    if (!result.ok && (mode === "run" || result.dpkgFailed)) {
      unavailable ||= incompleteInstall;
      return result;
    }
    if (result.ok && mode === "run") {
      installed.push(names);
      recordInstalled(installed);
    }
    const cleaned = await apt("apt-get", ["clean"], deadline, signal).catch(
      () => null,
    );
    if (!result.ok && !result.dpkgStarted && cleaned?.ok)
      chargedBytes[mode] -= estimated;
    return result;
  }

  return async function request(
    mode: InstallMode,
    names: string[],
    signal: AbortSignal,
  ) {
    if (unavailable) return packageFailure(mode, names, unavailable);
    if (mode === "run" && installed.length >= maxPackageRequests)
      return packageFailure(
        mode,
        names,
        `This run has reached its limit of ${maxPackageRequests} package install requests.`,
      );
    const apt = runApt(mode);
    const deadline =
      mode === "preset"
        ? (presetDeadline ??= Date.now() + packagePresetTimeout)
        : Date.now() + 210_000;
    if (!refreshed) {
      const index = await refreshIndex(mode, apt, deadline, signal).catch(
        () => couldNotStart,
      );
      if (!index.ok) return packageFailure(mode, names, index.output);
    }
    if (mode === "run")
      return install(names, mode, apt, deadline, signal).catch(
        () => couldNotStart,
      );

    // Each name gets its own apt plan so a missing package or an unsatisfiable
    // plan cannot prevent the rest of the preset from being installed.
    const results = [];
    let stopReason = "";
    for (const name of names) {
      stopReason ||=
        unavailable ||
        (signal.aborted ? cancelled.output : "") ||
        (Date.now() >= deadline ? timedOut.output : "");
      if (stopReason) {
        results.push({ name, ok: false, skipped: true, output: stopReason });
        continue;
      }
      const result: InstallResult = await install(
        [name],
        mode,
        apt,
        deadline,
        signal,
      ).catch(() => couldNotStart);
      const { ok, output, skip } = result;
      if (skip === "startup")
        stopReason = output.slice(0, maxPresetPackageOutput);
      results.push({
        name,
        ok,
        ...(skip && { skipped: true }),
        output: output.slice(0, maxPresetPackageOutput),
      });
    }
    const ok = results.every((result) => result.ok);
    return {
      ok,
      incomplete: !!stopReason,
      output:
        stopReason ||
        (ok
          ? "Preset packages are ready."
          : "Some preset packages could not be installed."),
      results,
    };
  };
}
