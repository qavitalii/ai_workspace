import { createInterface } from "node:readline";
const reply = (id: unknown, result: unknown) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  try {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === "initialize")
      reply(m.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "workspace-permissions", version: "0.1.0" },
      });
    else if (m.method === "tools/list")
      reply(m.id, {
        tools: [
          {
            name: "approve",
            description: "Request permission from the workspace owner",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      });
    else if (m.method === "tools/call") {
      const r = await fetch("http://127.0.0.1:47831/approve", {
        method: "POST",
        body: JSON.stringify(m.params.arguments),
      });
      if (!r.ok) throw new Error("Permission bridge unavailable");
      reply(m.id, {
        content: [{ type: "text", text: JSON.stringify(await r.json()) }],
      });
    } else if (m.method === "ping") reply(m.id, {});
    else
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32601, message: "Unknown method" },
        }) + "\n",
      );
  } catch {
    /* Fail closed; never synthesize an allow decision. */ process.exitCode = 1;
  }
});
