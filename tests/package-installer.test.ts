import { describe, expect, it, vi } from "vitest";
import {
  diskLimitError,
  estimateInstallBytes,
  packageBudgets,
  packageIndexAllowance,
  packageRunBudget,
  parseInstallPlan,
} from "../src/runner/package-disk.js";
import {
  createPackageInstaller,
  type RunApt,
} from "../src/runner/package-installer.js";
import { packageToolHandler } from "../src/runner/package-mcp.js";
import {
  maxPackageRequestBytes,
  packageNames,
} from "../src/runner/package-request.js";

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

  it("reads independent byte budgets and falls back for invalid values", () => {
    const budgets = packageBudgets({
      WORKSPACE_PACKAGE_RUN_BUDGET: "1048576",
      WORKSPACE_PACKAGE_PRESET_BUDGET: "0",
    });
    expect(budgets).toEqual({ run: MiB, preset: 0 });
    expect(diskLimitError(0, 1, 10n ** 12n, 3, budgets, "preset")).toContain(
      "0 bytes",
    );
    expect(
      diskLimitError(0, 1, BigInt(514 * MiB + 1), 3, budgets),
    ).toBeUndefined();
    expect(
      packageBudgets({
        WORKSPACE_PACKAGE_RUN_BUDGET: "1GiB",
        WORKSPACE_PACKAGE_PRESET_BUDGET: "9007199254740992",
      }),
    ).toEqual({ run: packageRunBudget, preset: packageRunBudget });
  });

  it("reserves for peers with more preset space than this project", () => {
    const peerPreset = 2048 * MiB;
    const requested = 16 * MiB;
    const budgets = packageBudgets({
      WORKSPACE_PACKAGE_PRESET_BUDGET: String(64 * MiB),
      WORKSPACE_PACKAGE_PEER_PRESET_BUDGET: String(peerPreset),
    });
    const required = BigInt(
      512 * MiB + 2 * (packageRunBudget + peerPreset) + requested,
    );
    expect(
      diskLimitError(0, requested, required - 1n, 3, budgets, "preset"),
    ).toContain("Docker disk");
    expect(
      diskLimitError(0, requested, required, 3, budgets, "preset"),
    ).toBeUndefined();
    expect(
      diskLimitError(0, requested, required - 1n, 3, budgets, "run"),
    ).toBeUndefined();
  });
});

it("accepts a full batch of 64 names in the request and MCP tool", async () => {
  const names = Array.from({ length: 64 }, (_, i) =>
    `package-${i}`.padEnd(63, "a"),
  );
  expect(Buffer.byteLength(JSON.stringify(names) + "\n")).toBeLessThan(
    maxPackageRequestBytes,
  );
  expect(packageNames(names)).toEqual(names);
  expect(packageNames([...names, "extra"])).toBeNull();
  const install = vi.fn(async () => ({ ok: true, output: "Ready" }));
  const write = vi.fn();
  const handle = packageToolHandler(install, write);
  await handle(JSON.stringify({ id: 1, method: "tools/list" }));
  expect(
    write.mock.calls[0][0].result.tools[0].inputSchema.properties.packages
      .maxItems,
  ).toBe(64);
  await handle(
    JSON.stringify({
      id: 2,
      method: "tools/call",
      params: { name: "install", arguments: { packages: names } },
    }),
  );
  expect(install).toHaveBeenCalledWith(names, expect.any(AbortSignal));
});

function fakeInstaller(budgets = packageBudgets({}), failAfterDpkg = false) {
  const apt = vi.fn<RunApt>(
    async (command, args, _deadline, _signal, onLine, trackDpkg) => {
      const name = /\?exact-name\(([^)]+)\)/.exec(args.at(-1) ?? "")?.[1];
      if (command === "apt-cache") {
        if (name === "apt-start-error")
          throw new Error("spawn apt-cache failed");
        if (name === "missing")
          return { ok: false, output: "E: No packages found" };
        if (name) onLine?.(`Package: ${name}`);
        if (!name) {
          for (const line of [
            "Package: sized",
            "Architecture: all",
            "Version: 1",
            "Size: 1000",
            "Installed-Size: 100",
          ])
            onLine?.(line);
        }
      } else if (args.includes("--simulate")) {
        if (name === "sized") {
          onLine?.("0 upgraded, 1 newly installed, 0 to remove.");
          onLine?.("Inst sized (1 Debian:12/oldstable [all])");
        } else {
          onLine?.("0 upgraded, 0 newly installed, 0 to remove.");
        }
      } else if (args.includes("install")) {
        if (name === "download-failed")
          return { ok: false, output: "Download failed" };
        if (name === "startup-timeout")
          return {
            ok: false,
            output: "Package installation timed out.",
            skip: "startup",
            interrupted: true,
          };
        if (name === "interrupted")
          return {
            ok: false,
            output: "Download interrupted",
            interrupted: true,
          };
        if (name === "dpkg-failed")
          return { ok: false, output: "dpkg failed", dpkgFailed: trackDpkg };
        if (name === "sized" && trackDpkg && failAfterDpkg)
          return {
            ok: false,
            output: "Post-install hook failed",
            dpkgStarted: true,
          };
      }
      return { ok: true, output: "Ready" };
    },
  );
  const recordInstalled = vi.fn();
  const install = createPackageInstaller({
    apt,
    recordInstalled,
    budgets,
    concurrency: 3,
    availableBytes: async () => 10n ** 12n,
  });
  return { apt, install, recordInstalled };
}

describe("Debian package presets", () => {
  const signal = new AbortController().signal;

  it("reports each failure and continues with the remaining packages", async () => {
    const { install, recordInstalled } = fakeInstaller();
    const result = await install(
      "preset",
      ["missing", "download-failed", "curl"],
      signal,
    );
    expect(result).toMatchObject({
      ok: false,
      incomplete: false,
      results: [
        {
          name: "missing",
          ok: false,
          output: expect.stringContaining("exact name"),
        },
        { name: "download-failed", ok: false, output: "Download failed" },
        { name: "curl", ok: true },
      ],
    });
    expect(result).not.toHaveProperty("results.0.skipped");
    expect(recordInstalled).not.toHaveBeenCalled();
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
    expect(recordInstalled).toHaveBeenCalledWith([["zip"]]);
  });

  it("reports the remaining packages and stops apt after a dpkg failure", async () => {
    const { apt, install } = fakeInstaller();
    expect(
      await install("preset", ["dpkg-failed", "curl"], signal),
    ).toMatchObject({
      ok: false,
      incomplete: true,
      results: [
        { name: "dpkg-failed", ok: false, output: "dpkg failed" },
        {
          name: "curl",
          ok: false,
          skipped: true,
          output: expect.stringContaining("did not finish cleanly"),
        },
      ],
    });
    const calls = apt.mock.calls.length;
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: false });
    expect(apt).toHaveBeenCalledTimes(calls);
  });

  it("shares the preset deadline across batches without limiting agent requests", async () => {
    const { install, apt } = fakeInstaller();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      expect(await install("preset", ["curl"], signal)).toMatchObject({
        ok: true,
      });
      const calls = apt.mock.calls.length;
      now.mockReturnValue(181_000);
      expect(await install("preset", ["zip"], signal)).toMatchObject({
        ok: false,
        incomplete: true,
        results: [{ name: "zip", ok: false, skipped: true }],
      });
      expect(apt).toHaveBeenCalledTimes(calls);
      expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
    } finally {
      now.mockRestore();
    }
  });

  it("skips the package in progress when the startup deadline interrupts apt", async () => {
    const { install, apt } = fakeInstaller();
    const timeout = {
      ok: false,
      skipped: true,
      output: "Package installation timed out.",
    };
    expect(
      await install("preset", ["curl", "startup-timeout", "zip"], signal),
    ).toMatchObject({
      incomplete: true,
      results: [
        { name: "curl", ok: true },
        { name: "startup-timeout", ...timeout },
        { name: "zip", ...timeout },
      ],
    });
    expect(
      apt.mock.calls.some(([, args]) => args.join(" ").includes("zip")),
    ).toBe(false);
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
  });

  it("keeps the broker usable after a preset interruption before dpkg", async () => {
    const { install } = fakeInstaller();
    expect(await install("preset", ["interrupted"], signal)).toMatchObject({
      ok: false,
      results: [{ name: "interrupted", output: "Download interrupted" }],
    });
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
  });

  it("skips pending presets when the installer cannot start apt", async () => {
    const { apt, install } = fakeInstaller();
    const skipped = {
      ok: false,
      skipped: true,
      output: "The package installer could not start Debian apt.",
    };

    expect(
      await install("preset", ["curl", "apt-start-error", "zip"], signal),
    ).toMatchObject({
      incomplete: true,
      output: skipped.output,
      results: [
        { name: "curl", ok: true },
        { name: "apt-start-error", ...skipped },
        { name: "zip", ...skipped },
      ],
    });
    expect(
      apt.mock.calls.some(([, args]) => args.at(-1)?.includes("zip")),
    ).toBe(false);
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
  });

  it("skips over-budget packages and keeps processing the preset", async () => {
    const { install } = fakeInstaller({
      run: 20 * MiB,
      preset: packageIndexAllowance + 20 * MiB,
    });
    expect(await install("preset", ["sized"], signal)).toMatchObject({
      ok: true,
    });
    expect(await install("preset", ["sized", "curl"], signal)).toMatchObject({
      ok: false,
      incomplete: false,
      results: [
        {
          name: "sized",
          ok: false,
          skipped: true,
          output: expect.stringContaining("budget for this preset"),
        },
        { name: "curl", ok: true },
      ],
    });
    expect(await install("preset", ["zip"], signal)).toMatchObject({
      ok: true,
    });
    expect(await install("run", ["sized"], signal)).toMatchObject({ ok: true });
    expect(await install("run", ["sized"], signal)).toMatchObject({
      ok: false,
      output: expect.stringContaining("budget for this run"),
    });
  });

  it("keeps the preset charge after an APT error following dpkg", async () => {
    const { install } = fakeInstaller(
      {
        run: 0,
        preset: packageIndexAllowance + 20 * MiB,
      },
      true,
    );
    expect(await install("preset", ["sized"], signal)).toMatchObject({
      ok: false,
      results: [{ name: "sized", output: "Post-install hook failed" }],
    });
    expect(await install("preset", ["sized"], signal)).toMatchObject({
      ok: false,
      results: [{ name: "sized", output: expect.stringContaining("preset") }],
    });
    expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
  });

  it("keeps the agent request limit separate from presets", async () => {
    const { install, recordInstalled } = fakeInstaller();
    for (let i = 0; i < 64; i++)
      expect(await install("run", ["zip"], signal)).toMatchObject({ ok: true });
    expect(recordInstalled).toHaveBeenCalledTimes(64);
    expect(await install("run", ["zip"], signal)).toMatchObject({
      ok: false,
      output: expect.stringContaining("64 package install requests"),
    });
    expect(await install("preset", ["zip"], signal)).toMatchObject({
      ok: true,
    });
    expect(recordInstalled).toHaveBeenCalledTimes(64);
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
