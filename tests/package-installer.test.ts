import { describe, expect, it, vi } from "vitest";
import {
  diskLimitError,
  estimateInstallBytes,
  packageRunBudget,
  parseInstallPlan,
} from "../src/runner/package-disk.js";
import { packageToolHandler } from "../src/runner/package-mcp.js";

const MiB = 1024 * 1024;

describe("Debian package budgets", () => {
  it("counts archives and full installed sizes for each exact version and architecture", () => {
    const plan = parseInstallPlan([
      "1 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.",
      "Inst libdemo:arm64 [1.0] (1:2.0+deb12u1 Debian:12/oldstable [arm64])",
      "Inst demo-data (2.1 Debian:12/oldstable [all])",
    ]);
    expect(plan?.map(({ argument }) => argument)).toEqual([
      "libdemo:arm64=1:2.0+deb12u1",
      "demo-data=2.1",
    ]);
    const metadata = [
      "Package: libdemo",
      "Architecture: arm64",
      "Version: 1:2.0+deb12u1",
      "Size: 10000",
      "Installed-Size: 512",
      "",
      "Package: demo-data",
      "Architecture: all",
      "Version: 2.1",
      "Size: 100000",
      "Installed-Size: 2048",
    ];
    expect(estimateInstallBytes(plan!, metadata)).toBe(
      Math.ceil((110_000 + (512 + 2048) * 1024) * 1.1) + 16 * MiB,
    );
    expect(estimateInstallBytes(plan!, metadata.slice(0, 5))).toBeNull();
    expect(estimateInstallBytes(plan!, metadata.slice(0, -1))).toBeNull();
  });

  it("rejects incomplete plans and accepts an already installed package", () => {
    expect(
      parseInstallPlan(["0 upgraded, 1 newly installed, 0 to remove."]),
    ).toBeNull();
    expect(
      parseInstallPlan(["0 upgraded, 0 newly installed, 1 to remove."]),
    ).toBeNull();
    expect(
      parseInstallPlan(["0 upgraded, 0 newly installed, 0 to remove."]),
    ).toEqual([]);
  });

  it("preserves headroom for other runs and charges previous installs cumulatively", () => {
    const requested = 256 * MiB;
    expect(
      diskLimitError(
        packageRunBudget - requested + 1,
        requested,
        10n ** 12n,
        3,
      ),
    ).toContain("budget");
    const reserve = BigInt(512 * MiB + 2 * packageRunBudget + requested);
    expect(diskLimitError(0, requested, reserve - 1n, 3)).toContain(
      "Docker disk",
    );
    expect(diskLimitError(0, requested, reserve, 3)).toBeUndefined();
  });
});

describe("package tool cancellation", () => {
  it("signals only the cancelled install and sends no result for it", async () => {
    const write = vi.fn();
    const signals = new Map<string, AbortSignal>();
    const finished = new Map<string, () => void>();
    const handle = packageToolHandler((names, signal) => {
      signals.set(names[0], signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
        finished.set(names[0], () => resolve({ ok: true, output: "Ready" }));
      });
    }, write);
    function call(id: number, name: string) {
      return handle(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "install", arguments: { packages: [name] } },
        }),
      );
    }
    const cancelled = call(1, "ffmpeg");
    const other = call(2, "zip");
    await handle(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 },
      }),
    );
    expect(signals.get("ffmpeg")?.aborted).toBe(true);
    expect(signals.get("zip")?.aborted).toBe(false);
    finished.get("zip")?.();
    await Promise.all([cancelled, other]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  it("cancels pending installs when the transport closes", async () => {
    const transport = new AbortController();
    const write = vi.fn();
    const handle = packageToolHandler(
      (_names, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("closed"))),
        ),
      write,
      transport.signal,
    );
    const request = handle(
      JSON.stringify({
        id: 1,
        method: "tools/call",
        params: { name: "install", arguments: { packages: ["ffmpeg"] } },
      }),
    );
    transport.abort();
    await request;
    expect(write).not.toHaveBeenCalled();
  });
});
