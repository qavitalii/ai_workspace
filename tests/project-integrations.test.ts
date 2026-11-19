import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeIntegrations,
  codexIntegrations,
} from "../src/runner/integrations";
import { integrationInput } from "../src/server/integrations";

const docs = {
  kind: "mcp",
  name: "docs",
  target: "https://example.test/mcp",
  token: "fixture-token",
} as const;

describe("project integrations", () => {
  it("passes the Codex bearer through the environment and selects the configured plugin", () => {
    const { args, env } = codexIntegrations([
      docs,
      { kind: "plugin", name: "demo", target: "demo@local" },
    ]);
    expect(args).toContain(
      'mcp_servers.ws_docs.bearer_token_env_var="WORKSPACE_MCP_TOKEN_docs"',
    );
    expect(args.join(" ")).not.toContain(docs.token);
    expect(env.WORKSPACE_MCP_TOKEN_docs).toBe(docs.token);
    expect(args).toContain('plugins."demo@local".enabled=true');
    expect(args.join(" ")).not.toContain("workspace_packages");
    const packages = codexIntegrations([docs], "workspace_packages_a85f14");
    expect(packages.args).toContain(
      'mcp_servers.workspace_packages_a85f14.tools.install.approval_mode="approve"',
    );
    expect(packages.args).toContain(
      'mcp_servers.workspace_packages_a85f14.enabled_tools=["install"]',
    );
    expect(packages.args.join(" ")).not.toContain("mcp_servers.ws_docs.tools");
  });

  it("keeps Claude's permission bridge alongside project servers and confines plugin paths", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "integrations-test-")),
    );
    const plugin = {
      kind: "plugin",
      name: "demo",
      target: "plugins/demo",
    } as const;
    let config: string | undefined;
    try {
      await mkdir(path.join(root, plugin.target), { recursive: true });
      const args = await claudeIntegrations(
        [docs, plugin],
        true,
        root,
        "workspace_packages_a85f14",
      );
      config = args[args.indexOf("--mcp-config") + 1];
      expect(args).toContain(path.join(root, plugin.target));
      expect(
        args.slice(
          args.indexOf("--allowedTools"),
          args.indexOf("--allowedTools") + 2,
        ),
      ).toEqual(["--allowedTools", "mcp__workspace_packages_a85f14__install"]);
      expect(args.join(" ")).not.toContain(docs.token);
      expect((await stat(config)).mode & 0o777).toBe(0o600);
      expect(
        JSON.parse(await readFile(config, "utf8")).mcpServers,
      ).toMatchObject({
        ws_docs: {
          type: "http",
          url: docs.target,
          headers: { Authorization: "Bearer " + docs.token },
        },
        workspace_permissions: { command: "node" },
        workspace_packages_a85f14: {
          command: "/usr/local/bin/node",
          args: ["/app/dist/node/runner/package-tools.js"],
        },
      });
      await symlink(path.dirname(root), path.join(root, "outside"));
      await expect(
        claudeIntegrations([{ ...plugin, target: "outside" }], false, root),
      ).rejects.toThrow("inside the working folder");
    } finally {
      if (config)
        await rm(path.dirname(config), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "bad-url",
    "http://example.test/mcp",
    "https://user:pw@example.test",
    "https://example.test/?token=example",
  ])("rejects invalid or credential-bearing endpoint %s", (target) => {
    expect(
      integrationInput.safeParse({ ...docs, target, provider: "both" }).success,
    ).toBe(false);
  });
});
