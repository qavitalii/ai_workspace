import os from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { docker } from "./runtime.js";
import { config } from "./config.js";

type CpuSample = { idle: number; total: number };
function cpuSample(): CpuSample {
  return os.cpus().reduce(
    (sum, cpu) => ({
      idle: sum.idle + cpu.times.idle,
      total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
    }),
    { idle: 0, total: 0 },
  );
}
export function cpuUsage(
  previous: CpuSample,
  current: CpuSample,
): number | null {
  const total = current.total - previous.total;
  if (total <= 0 || current.idle < previous.idle) return null;
  return (
    Math.round(
      Math.max(
        0,
        Math.min(100, (1 - (current.idle - previous.idle) / total) * 100),
      ) * 10,
    ) / 10
  );
}
export function memoryUsage(meminfo: string) {
  const read = (key: string) =>
    Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m"))?.[1]) *
    1024;
  const totalBytes = read("MemTotal"),
    availableBytes = read("MemAvailable");
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(availableBytes) ||
    totalBytes <= 0 ||
    availableBytes > totalBytes
  )
    return null;
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes };
}

/** Request-driven sampling is shared across clients; no per-browser Docker polling loop. */
export function createResourceMonitor() {
  let previous = cpuSample();
  let cached: any = null,
    sampled = 0;
  let pending: Promise<any> | null = null;
  let dockerInfo: { OperatingSystem?: string } | null = null,
    infoAt = 0;
  async function sample() {
    if (Date.now() - infoAt > 30000) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        dockerInfo = await Promise.race([
          docker.info(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Docker metrics unavailable")),
              1500,
            );
          }),
        ]);
      } catch {
        dockerInfo = null;
      } finally {
        clearTimeout(timeout);
        infoAt = Date.now();
      }
    }
    const current = cpuSample();
    const usedPercent = cpuUsage(previous, current);
    previous = current;
    const desktop =
      process.platform === "linux" &&
      /docker desktop/i.test(dockerInfo?.OperatingSystem || "");
    const memory =
      process.platform === "linux"
        ? await readFile("/proc/meminfo", "utf8")
            .then(memoryUsage)
            .catch(() => null)
        : {
            totalBytes: os.totalmem(),
            availableBytes: os.freemem(),
            usedBytes: os.totalmem() - os.freemem(),
          };
    let disk: {
      totalBytes: number;
      availableBytes: number;
      usedBytes: number;
    } | null = null;
    let diskNote = desktop
      ? "Host disk space is not exposed reliably by Docker Desktop."
      : "Disk information is temporarily unavailable.";
    if (!desktop && (process.platform !== "linux" || dockerInfo)) {
      try {
        const fs = await statfs(config.data);
        disk = {
          totalBytes: fs.blocks * fs.bsize,
          availableBytes: fs.bavail * fs.bsize,
          usedBytes: (fs.blocks - fs.bfree) * fs.bsize,
        };
        diskNote =
          "Filesystem containing workspace data. Space may also be used by other applications.";
      } catch {
        /* Keep unavailable metrics distinct from zero. */
      }
    }
    cached = {
      sampledAt: new Date().toISOString(),
      scope: desktop
        ? "Docker Desktop VM"
        : process.platform === "linux"
          ? "Server"
          : "Local computer",
      cpu: {
        cores: os.cpus().length,
        usedPercent,
        availablePercent:
          usedPercent === null
            ? null
            : Math.round((100 - usedPercent) * 10) / 10,
      },
      memory,
      disk,
      diskNote,
    };
    sampled = Date.now();
    return cached;
  }
  return {
    read() {
      if (cached && Date.now() - sampled < 1500) return Promise.resolve(cached);
      if (!pending)
        pending = sample().finally(() => {
          pending = null;
        });
      return pending;
    },
  };
}
