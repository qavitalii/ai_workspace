import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { promisify } from "node:util";
import { packageBudgets } from "./package-disk.js";
import { createPackageInstaller, type RunApt } from "./package-installer.js";
import { projectPackageNames } from "./package-request.js";

const [slots, ...args] = process.argv.slice(2);
const concurrency = Number(slots);
const packages = projectPackageNames(args);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !packages)
  throw new Error("Invalid project image package request.");

const exec = promisify(execFile);
const env = {
  ...process.env,
  LC_ALL: "C",
  DEBIAN_FRONTEND: "noninteractive",
  APT_CONFIG: "/etc/workspace-install/apt.conf",
};
const apt: RunApt = async (command, arguments_, deadline, signal, onLine) => {
  try {
    const { stdout } = await exec(command, arguments_, {
      env,
      timeout: Math.max(1, deadline - Date.now()),
      signal,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (onLine) for (const line of stdout.split("\n")) onLine(line);
    return { ok: true, output: "" };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    // execFile's message can include the whole argument list.
    const output = [failure.stdout, failure.stderr].filter(Boolean).join("\n");
    return { ok: false, output: (output || failure.message).slice(-8192) };
  }
};

const install = createPackageInstaller({
  apt,
  // The background build occupies one slot and reserves space for every
  // foreground slot, which can start while Docker is cancelling it.
  concurrency: concurrency + 1,
  budgets: packageBudgets(process.env),
  async availableBytes() {
    const disk = await statfs("/", { bigint: true });
    return disk.bavail * disk.bsize;
  },
  recordInstalled() {},
});

const result = await install("run", packages, new AbortController().signal);
if (!result.ok) {
  console.error(result.output);
  process.exit(1);
}

const { stdout } = await exec("dpkg-query", [
  "-W",
  "-f",
  "${Package}\t${db:Status-Status}\n",
  "--",
  ...packages,
]);
const installed = new Set(stdout.split("\n"));
const missing = packages.filter((name) => !installed.has(name + "\tinstalled"));
if (missing.length)
  throw new Error("Packages were not installed: " + missing.join(", "));
