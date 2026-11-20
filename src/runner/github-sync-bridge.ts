import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";

export function githubSyncBridge(requestSync: (id: string) => void) {
  let pending: { id: string; response: ServerResponse } | undefined;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/sync") {
      response.writeHead(404).end();
      return;
    }
    if (pending) {
      response.writeHead(409).end();
      return;
    }
    const id = randomUUID();
    pending = { id, response };
    response.once("close", () => {
      if (pending?.id === id) pending = undefined;
    });
    requestSync(id);
  });
  return {
    async start() {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      server.unref();
      const address = server.address();
      if (!address || typeof address === "string")
        throw Error("Could not bind the GitHub sync tool.");
      return address.port;
    },
    reply(id: string, message: string, ok: boolean) {
      if (pending?.id !== id) return;
      pending.response.setHeader("Content-Type", "application/json");
      pending.response.end(JSON.stringify({ message, ok }));
    },
  };
}
