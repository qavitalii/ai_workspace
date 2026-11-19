import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  realpath,
  readFile,
  open,
  stat,
  writeFile,
  mkdtemp,
  mkdir,
  symlink,
  readdir,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import type { ProjectIntegration } from "../shared.js";

const exec = promisify(execFile);

export function codexIntegrations(entries: ProjectIntegration[]) {
  const args: string[] = [];
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind === "plugin") {
      args.push("-c", `plugins.${JSON.stringify(entry.target)}.enabled=true`);
      continue;
    }
    const server = "mcp_servers.ws_" + entry.name;
    args.push("-c", server + ".url=" + JSON.stringify(entry.target));
    if (entry.token) {
      const key = "WORKSPACE_MCP_TOKEN_" + entry.name;
      env[key] = entry.token;
      args.push("-c", server + ".bearer_token_env_var=" + JSON.stringify(key));
    }
  }
  return { args, env };
}

export async function claudeIntegrations(
  entries: ProjectIntegration[],
  approvalBridge: boolean,
  root = "/workspace",
) {
  const args: string[] = [];
  const servers: Record<string, unknown> = {};
  if (approvalBridge)
    servers.workspace_permissions = {
      command: "node",
      args: ["/app/dist/node/runner/permissions.js"],
    };
  for (const entry of entries) {
    if (entry.kind === "plugin") {
      const dir = await realpath(path.join(root, entry.target));
      if (!dir.startsWith(root + "/") || !(await stat(dir)).isDirectory())
        throw new Error(
          "Plugin must be a directory inside the working folder.",
        );
      args.push("--plugin-dir", dir);
    } else {
      servers["ws_" + entry.name] = {
        type: "http",
        url: entry.target,
        ...(entry.token
          ? { headers: { Authorization: "Bearer " + entry.token } }
          : {}),
      };
    }
  }
  if (Object.keys(servers).length) {
    const dir = await mkdtemp("/tmp/workspace-mcp-");
    const config = path.join(dir, "servers.json");
    await writeFile(config, JSON.stringify({ mcpServers: servers }), {
      mode: 0o600,
    });
    args.push("--mcp-config", config);
  }
  return args;
}

// Give plugin installation a disposable config and cache while keeping the
// account's credentials and resumable chat histories in their normal paths.
export async function codexPluginHome(entries: ProjectIntegration[]) {
  const plugins = entries.filter((entry) => entry.kind === "plugin");
  if (!plugins.length) return undefined;
  const workspace = "/workspace";
  const catalogPath = path.join(workspace, ".agents/plugins/marketplace.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  for (const plugin of plugins) {
    const [name, marketplace] = plugin.target.split("@");
    const source = catalog.plugins?.find(
      (item: { name: string }) => item.name === name,
    )?.source;
    if (
      catalog.name !== marketplace ||
      source?.source !== "local" ||
      typeof source.path !== "string"
    )
      throw new Error(
        "Expected a local working-folder plugin: " + plugin.target,
      );
    const directory = await realpath(path.resolve(workspace, source.path));
    if (
      !directory.startsWith(workspace + "/") ||
      !(await stat(directory)).isDirectory()
    )
      throw new Error(
        "Codex plugin must be a directory inside the working folder.",
      );
  }
  const original = "/profile/.codex";
  const home = await mkdtemp("/tmp/workspace-codex-");
  for (const folder of ["sessions", "archived_sessions"])
    await mkdir(path.join(original, folder), { recursive: true });
  // The CLI locks this file when refreshing credentials and resolves the
  // auth.json symlink before atomically replacing the credential document.
  await (await open(path.join(original, "auth.lock"), "a", 0o600)).close();
  for (const item of await readdir(original)) {
    if (item === "config.toml")
      await copyFile(path.join(original, item), path.join(home, item));
    else if (item !== "plugins")
      await symlink(path.join(original, item), path.join(home, item));
  }
  const env = { ...process.env, CODEX_HOME: home };
  // Register the marketplace from the current working copy in this run only.
  await exec("codex", ["plugin", "marketplace", "add", "/workspace"], {
    env,
    timeout: 30000,
  });
  for (const plugin of plugins) {
    await exec("codex", ["plugin", "add", plugin.target], {
      env,
      timeout: 60000,
    });
  }
  // Preserve other plugins already installed in the account, while letting
  // this run's freshly installed plugin take precedence.
  async function inherit(source: string, target: string, depth: number) {
    const items = await readdir(source).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    await mkdir(target, { recursive: true });
    for (const item of items) {
      const from = path.join(source, item),
        to = path.join(target, item);
      try {
        await symlink(from, to);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        if (
          depth > 0 &&
          (await stat(from)).isDirectory() &&
          (await stat(to)).isDirectory()
        )
          await inherit(from, to, depth - 1);
      }
    }
  }
  await inherit(
    path.join(original, "plugins/cache"),
    path.join(home, "plugins/cache"),
    1,
  );
  return home;
}
