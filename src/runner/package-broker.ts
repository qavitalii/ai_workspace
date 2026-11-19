import { spawn } from "node:child_process";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  packageAuditPath,
  packageNames,
  packageSocket,
  packageUsage,
} from "./package-request.js";
import {
  diskLimitError,
  estimateInstallBytes,
  packageIndexAllowance,
  parseInstallPlan,
} from "./package-disk.js";

const aptEnvironment = {
  APT_CONFIG: "/etc/workspace-install/apt.conf",
  DEBIAN_FRONTEND: "noninteractive",
  HOME: "/var/lib/workspace-install",
  LC_ALL: "C",
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  TMPDIR: "/var/lib/workspace-install/tmp",
};
const maxLogBytes = 8192;
const maximumRunners = Number(process.env.WORKSPACE_PACKAGE_CONCURRENCY ?? 3);
const concurrency =
  Number.isSafeInteger(maximumRunners) && maximumRunners >= 1
    ? maximumRunners
    : 3;
const cancelled = {
  ok: false,
  output: "Package installation was cancelled.",
} as const;
const timedOut = {
  ok: false,
  output: "Package installation timed out.",
} as const;
let unavailable = "";
function apt(
  command: "apt-get" | "apt-cache",
  args: string[],
  deadline: number,
  signal: AbortSignal,
  onLine = (_line: string) => {},
): Promise<{ ok: boolean; output: string }> {
  if (signal.aborted) return Promise.resolve(cancelled);
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) return Promise.resolve(timedOut);
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    const child = spawn("/usr/bin/" + command, args, {
      cwd: aptEnvironment.HOME,
      env: aptEnvironment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const pipe of [child.stdout, child.stderr])
      pipe.on("data", (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]).subarray(-maxLogBytes);
      });
    createInterface({ input: child.stdout }).on("line", onLine);
    function interrupt(result: { ok: false; output: string }) {
      // Helpers running as _apt may outlive the root child. Settle the
      // request immediately and never start another apt in this container.
      unavailable = result.output + " Start a new run to retry.";
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // A child that already exited no longer needs a signal.
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      release();
      resolve(result);
    }
    const abort = () => interrupt(cancelled);
    const timeout = setTimeout(() => interrupt(timedOut), timeLeft);
    signal.addEventListener("abort", abort, { once: true });
    function release() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
    child.once("error", (error) => {
      release();
      reject(error);
    });
    child.once("close", (code) => {
      release();
      resolve({
        ok: code === 0,
        output: output.toString("utf8").trim(),
      });
    });
  });
}

let refreshed = false;
let chargedBytes = 0;
const installed: string[][] = [];

async function checkDisk(requested: number) {
  let available;
  try {
    const disk = await statfs(aptEnvironment.HOME, { bigint: true });
    available = disk.bavail * disk.bsize;
  } catch {
    return "Could not verify available space on the Docker disk.";
  }
  return diskLimitError(chargedBytes, requested, available, concurrency);
}

async function install(names: string[], signal: AbortSignal) {
  const deadline = Date.now() + 210_000;
  if (!refreshed) {
    const error = await checkDisk(packageIndexAllowance);
    if (error) return { ok: false, output: error };
    const updated = await apt(
      "apt-get",
      ["-q", "update", "--error-on=any"],
      deadline,
      signal,
    );
    if (!updated.ok) return updated;
    refreshed = true;
    chargedBytes += packageIndexAllowance;
  }
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
  if (unavailable || signal.aborted) return checked;
  const missing = names.filter((name) => !found.has(name));
  if (missing.length)
    return {
      ok: false,
      output: "No Debian package found with exact name: " + missing.join(", "),
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
  const error = await checkDisk(estimated);
  if (error) return { ok: false, output: error };
  if (signal.aborted) return cancelled;
  if (Date.now() >= deadline) return timedOut;
  chargedBytes += estimated;
  const result = await apt("apt-get", installArguments, deadline, signal);
  if (result.ok) {
    // Keep the agent runner as the only writer to Docker's JSON stdout.
    // Publish the snapshot atomically before replying to the client.
    const temporary = packageAuditPath + ".new";
    installed.push(names);
    writeFileSync(temporary, JSON.stringify(installed), { mode: 0o644 });
    renameSync(temporary, packageAuditPath);
    await apt("apt-get", ["clean"], deadline, signal).catch(() => {});
  } else {
    unavailable ||=
      "A package installation did not finish cleanly. Start a new run to retry.";
  }
  return result;
}

function reply(socket: Socket, ok: boolean, output: string) {
  socket.end(JSON.stringify({ ok, output }) + "\n");
}

let busy = false;
const server = createServer((socket) => {
  let request = "";
  let accepted = false;
  const abort = new AbortController();
  socket.on("error", () => {});
  socket.once("end", () => abort.abort());
  socket.once("close", () => abort.abort());
  socket.setTimeout(5000, () => socket.destroy());
  socket.setEncoding("utf8");
  socket.on("data", async (chunk) => {
    if (accepted) {
      socket.destroy();
      return;
    }
    request += chunk;
    if (request.length > 2048) {
      socket.destroy();
      return;
    }
    const newline = request.indexOf("\n");
    if (newline < 0) return;
    accepted = true;
    socket.setTimeout(0);
    let names: string[] | null = null;
    try {
      names = packageNames(JSON.parse(request.slice(0, newline)));
    } catch {}
    if (!names) {
      reply(socket, false, packageUsage);
      return;
    }
    if (unavailable) {
      reply(socket, false, unavailable);
      return;
    }
    if (installed.length >= 64) {
      reply(
        socket,
        false,
        "This run has reached its limit of 64 package install requests.",
      );
      return;
    }
    if (busy) {
      reply(
        socket,
        false,
        "Another package installation is running. Retry after it finishes.",
      );
      return;
    }
    busy = true;
    try {
      const result = await install(names, abort.signal);
      if (!abort.signal.aborted) reply(socket, result.ok, result.output);
    } catch {
      if (!abort.signal.aborted)
        reply(
          socket,
          false,
          "The package installer could not start Debian apt.",
        );
    } finally {
      busy = false;
    }
  });
});
server.maxConnections = 8;
server.listen(packageSocket, () => {
  chmodSync(packageSocket, 0o666);
  writeFileSync("/run/workspace-packages/ready", "");
});
