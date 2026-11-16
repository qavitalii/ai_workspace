import { commandsFor, slashCommand } from "../src/commands";
import { uploadPath } from "../src/server/folder-routes";
import { folderName } from "../src/server/folders";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  safeName,
  confined,
  seal,
  unseal,
  redact,
} from "../src/server/security";
import { config } from "../src/server/config";
import {
  quotaError,
  validRepo,
  cleanTerminalText,
  claudeSignInUrl,
  normalizeGithubRepo,
} from "../src/shared";
import { cpuUsage, memoryUsage } from "../src/server/resources";
let root: string;
beforeAll(async () => {
  config.key = "ab".repeat(32);
  root = await mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
  await mkdir(path.join(root, "project"));
  await writeFile(path.join(root, "project", "ok.txt"), "ok");
  await writeFile(path.join(root, "secret"), "private");
  await symlink(
    path.join(root, "secret"),
    path.join(root, "project", "escape"),
  );
});
afterAll(() => rm(root, { recursive: true, force: true }));
describe("workspace boundaries", () => {
  it("allows real project files", async () =>
    expect(await confined(path.join(root, "project"), "ok.txt")).toBe(
      await realpath(path.join(root, "project", "ok.txt")),
    ));
  it("rejects traversal, absolute paths, git internals and escaping links", async () => {
    for (const p of ["../secret", "/etc/passwd", ".git/config", "escape"])
      await expect(confined(path.join(root, "project"), p)).rejects.toThrow();
  });
  it("normalizes attachment names", () => {
    expect(safeName("../../secret.txt")).toBe("secret.txt");
    expect(safeName("..\\x\u0000.txt")).toBe("x.txt");
  });
});
describe("secrets and provider failures", () => {
  it("normalizes GitHub repository links and rejects other destinations", () => {
    for (const value of [
      "qavitalii/partcar",
      " https://github.com/qavitalii/partcar ",
      "https://github.com/qavitalii/partcar.git/",
      "https://github.com/qavitalii/partcar?tab=readme-ov-file#readme",
    ])
      expect(normalizeGithubRepo(value)).toBe("qavitalii/partcar");
    for (const value of [
      "https://github.com.evil.test/a/b",
      "https://user:secret@github.com/a/b",
      "https://github.com/a/b/tree/main",
      "https://github.com:8443/a/b",
      "file:///a/b",
      "a/b/c",
      "../secret",
      "https://github.com/a/%2e%2e",
    ])
      expect(normalizeGithubRepo(value)).toBeNull();
  });
  it("calculates CPU usage from elapsed counters and keeps missing samples unknown", () => {
    expect(cpuUsage({ idle: 100, total: 200 }, { idle: 150, total: 400 })).toBe(
      75,
    );
    expect(
      cpuUsage({ idle: 100, total: 200 }, { idle: 100, total: 200 }),
    ).toBeNull();
  });
  it("uses available memory including reclaimable cache instead of only free memory", () => {
    expect(
      memoryUsage(
        "MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    700 kB\n",
      ),
    ).toEqual({
      totalBytes: 1024000,
      availableBytes: 716800,
      usedBytes: 307200,
    });
    expect(memoryUsage("MemTotal: 1000 kB\nMemFree: 100 kB\n")).toBeNull();
  });
  it("extracts the native Claude login link from terminal hyperlinks", () => {
    const url = "https://claude.com/cai/oauth/authorize?code=true&state=test";
    const output = `\x1b[32mVisit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\x1b[0m\nPaste code here > `;
    expect(cleanTerminalText(output)).toBe(`Visit: ${url}\nPaste code here > `);
    expect(claudeSignInUrl(output)).toBe(url);
    expect(
      claudeSignInUrl("https://claude.com.evil.example/login"),
    ).toBeUndefined();
  });
  it("authenticates encrypted secrets and rejects tampering", () => {
    const encoded = seal("private-token");
    expect(unseal(encoded)).toBe("private-token");
    const b = Buffer.from(encoded, "base64");
    b[15] ^= 1;
    expect(() => unseal(b.toString("base64"))).toThrow();
  });
  it("never mistakes transport/tool failures for an account quota", () => {
    for (const e of [
      "ETIMEDOUT",
      "command_failed",
      "429",
      "permission_denied",
      "invalid_api_key",
    ])
      expect(quotaError(e)).toBe(false);
    expect(quotaError("usage_limit_reached")).toBe(true);
  });
  it("redacts common credential formats", () =>
    expect(redact("token ghp_abcdefghijklmnopqrst")).not.toContain(
      "abcdefghijklmnopqrst",
    ));
  it("accepts only owner/repository GitHub identifiers", () => {
    expect(validRepo("qavitalii/ai_workspace")).toBe(true);
    for (const r of [
      "../../etc",
      "https://evil.test/repo",
      "x/y/z",
      "x/..",
      "x/repo;id",
    ])
      expect(validRepo(r)).toBe(false);
  });
});

it("validates folder names and nested upload paths", () => {
  expect(folderName("project-assets")).toBe("project-assets");
  expect(uploadPath("photos/trip/photo.png")).toBe("photos/trip/photo.png");
  for (const value of [
    "../secret",
    "/etc/passwd",
    "photos/../secret",
    "a\\b",
    ".git/config",
    "a//b",
    "a/./b",
    "a\0b",
  ])
    expect(() => uploadPath(value)).toThrow();
  for (const value of ["..", ".", "/srv", "a/b", ".ssh", ""])
    expect(() => folderName(value)).toThrow();
});

describe("provider command menus", () => {
  it("keeps provider-only commands separate and requires native discovery for Claude skills", () => {
    const codex = commandsFor("codex"),
      claude = commandsFor("claude", ["context", "custom-skill"]);
    expect(codex.find((c) => c.name === "plan")?.unavailable).toBeUndefined();
    expect(codex.some((c) => c.name === "review")).toBe(true);
    expect(claude.some((c) => c.name === "review")).toBe(false);
    expect(claude.find((c) => c.name === "custom-skill")).toMatchObject({
      native: true,
    });
    expect(
      commandsFor("claude").find((c) => c.name === "context")?.unavailable,
    ).toBeTruthy();
    expect(slashCommand("/plan Build a page")).toEqual({
      name: "plan",
      arguments: "Build a page",
    });
    expect(slashCommand("Open /workspace/file.txt")).toBeNull();
  });
});
