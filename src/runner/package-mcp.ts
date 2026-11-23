import type { PackageInstallResult } from "./package-client.js";
import {
  packageNamePattern,
  packageNames,
  packageRequestLimit,
  packageUsage,
} from "./package-request.js";

export function packageToolHandler(
  install: (
    names: string[],
    signal: AbortSignal,
  ) => Promise<PackageInstallResult>,
  write: (message: object) => void,
  transport?: AbortSignal,
) {
  const pending = new Map<string | number, AbortController>();
  transport?.addEventListener(
    "abort",
    () => {
      for (const controller of pending.values()) controller.abort();
    },
    { once: true },
  );
  function reply(id: unknown, data: object) {
    write({ jsonrpc: "2.0", id, ...data });
  }
  function result(id: unknown, text: string, isError = false) {
    reply(id, { result: { content: [{ type: "text", text }], isError } });
  }
  return async function handleLine(line: string) {
    if (transport?.aborted) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      reply(null, { error: { code: -32700, message: "Invalid JSON" } });
      return;
    }
    if (request?.id === undefined) {
      if (request?.method === "notifications/cancelled")
        pending.get(request.params?.requestId)?.abort();
      return;
    }
    const { id, method, params } = request;
    if (typeof id !== "number" && typeof id !== "string") return;
    switch (method) {
      case "initialize":
        reply(id, {
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "workspace-packages", version: "1.0.0" },
          },
        });
        break;
      case "ping":
        reply(id, { result: {} });
        break;
      case "tools/list":
        reply(id, {
          result: {
            tools: [
              {
                name: "install",
                description: `Install named Debian packages in the agent runner. ${packageRequestLimit}`,
                inputSchema: {
                  type: "object",
                  properties: {
                    packages: {
                      type: "array",
                      items: { type: "string", pattern: packageNamePattern },
                      minItems: 1,
                    },
                  },
                  required: ["packages"],
                  additionalProperties: false,
                },
              },
            ],
          },
        });
        break;
      case "tools/call": {
        const names = packageNames(params?.arguments?.packages);
        if (
          params?.name !== "install" ||
          !names ||
          Object.keys(params.arguments).length !== 1
        ) {
          result(id, packageUsage, true);
          break;
        }
        if (pending.has(id)) return;
        const controller = new AbortController();
        pending.set(id, controller);
        try {
          const { ok, output } = await install(names, controller.signal);
          if (!controller.signal.aborted)
            result(
              id,
              output.trim().slice(0, 4000) ||
                (ok
                  ? "Packages ready for this run."
                  : "Package installation failed."),
              !ok,
            );
        } catch (error) {
          if (!controller.signal.aborted)
            result(id, (error as Error).message, true);
        } finally {
          pending.delete(id);
        }
        break;
      }
      default:
        reply(id, { error: { code: -32601, message: "Unknown method" } });
    }
  };
}
