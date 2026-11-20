import { createInterface } from "node:readline";

const port = Number(process.argv[2]);
const input = createInterface({ input: process.stdin });
const syncTool = {
  name: "sync_from_github",
  description:
    "Update the current working folder from the project’s GitHub base branch using the project’s saved access. Local edits and conflicting commits are preserved. Call this only when the user asks to sync, before making edits.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof request?.id !== "string" && typeof request?.id !== "number")
    return;
  const reply = (payload: object) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, ...payload }) + "\n",
    );
  switch (request.method) {
    case "initialize":
      reply({
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "workspace-github", version: "1.0.0" },
        },
      });
      break;
    case "ping":
      reply({ result: {} });
      break;
    case "tools/list":
      reply({ result: { tools: [syncTool] } });
      break;
    case "tools/call": {
      const { name, arguments: args = {} } = request.params ?? {};
      if (
        name !== syncTool.name ||
        !args ||
        Array.isArray(args) ||
        typeof args !== "object" ||
        Object.keys(args).length
      ) {
        reply({ error: { code: -32602, message: "Sync takes no arguments." } });
        break;
      }
      let message =
        "Workspace could not complete GitHub sync. Check the folder’s Sync from GitHub action.";
      let ok = false;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/sync`, {
          method: "POST",
          signal: AbortSignal.timeout(285_000),
        });
        if (response.ok) ({ message, ok } = await response.json());
        else if (response.status === 409)
          message = "A GitHub sync is already running for this folder.";
      } catch {
        // A stopped runner or expired request cannot return a sync result.
      }
      reply({
        result: { content: [{ type: "text", text: message }], isError: !ok },
      });
      break;
    }
    default:
      reply({ error: { code: -32601, message: "Unknown method" } });
  }
});
