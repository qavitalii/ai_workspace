import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { statfs } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import {
  maxPackageRequestBytes,
  packageAuditPath,
  packageNames,
  packagePresetDirectory,
  packagePresetSocket,
  packageSocket,
  packageUsage,
} from "./package-request.js";
import { packageBudgets } from "./package-disk.js";
import {
  createPackageInstaller,
  packageFailure,
  type InstallMode,
  type RunApt,
} from "./package-installer.js";

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
let interruptedGroup: number | undefined;

function aptIsStopping() {
  if (interruptedGroup === undefined) return false;
  try {
    process.kill(-interruptedGroup, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      interruptedGroup = undefined;
      return false;
    }
  }
  // The runner can keep unreaped zombies. Only living group members can
  // still hold locks or write to APT's cache.
  let processes: string[];
  try {
    processes = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const pid of processes) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(group) === interruptedGroup && state !== "Z" && state !== "X")
        return true;
    } catch (error) {
      // Processes may exit during the scan. Keep waiting on other errors.
      if (
        !["ENOENT", "ESRCH"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return true;
    }
  }
  interruptedGroup = undefined;
  return false;
}

const apt: RunApt = (command, args, deadline, signal, onLine, trackDpkg) => {
  const cancelled = "Package installation was cancelled.";
  const timedOut = "Package installation timed out.";
  if (signal.aborted) return Promise.resolve({ ok: false, output: cancelled });
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) return Promise.resolve({ ok: false, output: timedOut });

  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    let dpkgStarted = false;
    let dpkgFailed = false;
    let interruption = "";
    let closePipes: NodeJS.Timeout | undefined;
    const child = spawn(
      "/usr/bin/" + command,
      trackDpkg ? ["-o", "APT::Status-Fd=3", ...args] : args,
      {
        cwd: aptEnvironment.HOME,
        env: aptEnvironment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", trackDpkg ? "pipe" : "ignore"],
      },
    );
    const pipes = [child.stdout!, child.stderr!];
    const progress = child.stdio[3];
    for (const pipe of pipes)
      pipe.on("data", (chunk: Buffer) => {
        output = Buffer.concat([output, chunk]).subarray(-maxLogBytes);
      });
    if (onLine) createInterface({ input: child.stdout! }).on("line", onLine);
    if (progress && "read" in progress)
      createInterface({ input: progress }).on("line", (line) => {
        // Apt writes this record just before it forks dpkg.
        if (line.startsWith("pmstatus:dpkg-exec:")) dpkgStarted = true;
        if (line.startsWith("pmerror:")) dpkgFailed = true;
      });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      // Apt also reports dpkg process failures without a pmerror record.
      if (
        /^E: (?:Sub-process \/usr\/bin\/dpkg |dpkg was interrupted,)/.test(line)
      )
        dpkgFailed = true;
    });

    function interrupt(reason: string) {
      if (interruption) return;
      interruption = reason;
      interruptedGroup = child.pid;
      // Give apt a chance to shut down its acquisition workers gracefully.
      child.kill("SIGINT");
      closePipes = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // The group may already have exited.
          }
        }
        for (const pipe of pipes) pipe.destroy();
        progress?.destroy();
      }, 1000);
    }
    const abort = () => interrupt(cancelled);
    const timeout = setTimeout(() => interrupt(timedOut), timeLeft);
    signal.addEventListener("abort", abort, { once: true });
    function release() {
      clearTimeout(timeout);
      clearTimeout(closePipes);
      signal.removeEventListener("abort", abort);
    }
    child.once("error", (error) => {
      release();
      reject(error);
    });
    child.once("close", (code) => {
      release();
      const ok = !interruption && code === 0;
      resolve({
        ok,
        output: interruption || output.toString("utf8").trim(),
        interrupted: Boolean(interruption),
        dpkgStarted,
        dpkgFailed:
          !ok &&
          (dpkgFailed || (dpkgStarted && (!!interruption || code === null))),
      });
    });
  });
};

const install = createPackageInstaller({
  apt,
  concurrency,
  budgets: packageBudgets(process.env),
  async availableBytes() {
    const disk = await statfs(aptEnvironment.HOME, { bigint: true });
    return disk.bavail * disk.bsize;
  },
  recordInstalled(names) {
    // Publish the snapshot atomically before replying to the client.
    const temporary = packageAuditPath + ".new";
    writeFileSync(temporary, JSON.stringify(names), { mode: 0o644 });
    renameSync(temporary, packageAuditPath);
  },
});

function reply(socket: Socket, result: object) {
  socket.end(JSON.stringify(result) + "\n");
}

let busy = false;
function packageServer(mode: InstallMode) {
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
      if (request.length > maxPackageRequestBytes) {
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
        reply(socket, { ok: false, output: packageUsage });
        return;
      }
      if (busy || aptIsStopping()) {
        reply(
          socket,
          packageFailure(
            mode,
            names,
            "Another package installation is running. Retry after it finishes.",
          ),
        );
        return;
      }
      busy = true;
      try {
        const result = await install(mode, names, abort.signal);
        if (!abort.signal.aborted) {
          const { ok, output } = result;
          reply(socket, mode === "preset" ? result : { ok, output });
        }
      } finally {
        busy = false;
      }
    });
  });
  server.maxConnections = 8;
  return server;
}

// The bootstrap caller can use the preset budget through a root-only directory.
// Agent requests keep their existing protocol on the public socket.
mkdirSync(packagePresetDirectory, { mode: 0o700 });
packageServer("preset").listen(packagePresetSocket, () => {
  packageServer("run").listen(packageSocket, () => {
    chmodSync(packageSocket, 0o666);
    writeFileSync("/run/workspace-packages/ready", "");
  });
});
