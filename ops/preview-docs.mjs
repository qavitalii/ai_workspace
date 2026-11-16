// Local-only screenshot fixture. Never connects to a database or provider.
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
const accounts = [
  {
    id: "demo-codex",
    name: "Codex",
    provider: "codex",
    status: "ready",
    limits: {
      primary: { usedPercent: 18, windowDurationMins: 300 },
      secondary: { usedPercent: 32, windowDurationMins: 10080 },
    },
  },
  {
    id: "demo-claude",
    name: "Claude",
    provider: "claude",
    status: "ready",
    limits: {
      windows: {
        five_hour: { utilization: 0.12 },
        seven_day: { utilization: 0.26 },
      },
    },
  },
];
const projects = [
  {
    id: "demo-project",
    name: "Studio website",
    repo: "example/studio-website",
    base_branch: "main",
  },
];
const chats = [
  {
    id: "demo-chat",
    project_id: "demo-project",
    title: "Getting started",
    provider: "codex",
    model: "gpt-5.4",
    effort: "high",
    account_id: "demo-codex",
    state: "completed",
    mode: "default",
    autonomous: false,
  },
  {
    id: "demo-review",
    project_id: "demo-project",
    title: "Mobile navigation",
    provider: "claude",
    model: "sonnet",
    account_id: "demo-claude",
    state: "completed",
  },
  {
    id: "demo-notes",
    project_id: null,
    title: "Release planning",
    provider: "claude",
    model: "sonnet",
    account_id: "demo-claude",
    state: "completed",
  },
];
const messages = [
  {
    id: "m1",
    role: "user",
    content: "Simplify the setup guide and check its links.",
    created_at: "2026-11-16T09:40:00Z",
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "The setup guide is ready to review.\n\n### Changes\n- Added a three-step checklist.\n- Separated setup from troubleshooting.\n- Fixed the deployment links.\n\nBuild and link checks passed. Open **Changes** to review the diff.",
    created_at: "2026-11-16T09:42:00Z",
  },
];
const preview = await createServer({
  configFile: false,
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
  plugins: [
    {
      name: "documentation-fixture",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = new URL(req.url, "http://localhost").pathname;
          if (path === "/__docs/frame" || path === "/__docs/mobile") {
            res.setHeader("Content-Type", "text/html");
            res.end(
              readFileSync(
                new URL(
                  path === "/__docs/mobile"
                    ? "./docs-mobile.html"
                    : "./docs-frame.html",
                  import.meta.url,
                ),
                "utf8",
              ),
            );
            return;
          }
          if (!path.startsWith("/api/")) return next();
          let data;
          if (req.method !== "GET") {
            res.statusCode = 405;
            data = { error: "Read-only documentation preview" };
          } else if (path === "/api/me") data = { ok: true };
          else if (path === "/api/overview")
            data = { accounts, projects, chats };
          else if (path === "/api/chats/demo-chat")
            data = {
              chat: chats[0],
              messages,
              attachments: [],
              jobs: [],
              approvals: [],
              events: [],
            };
          else if (path === "/api/settings/models")
            data = {
              codex: { model: "", effort: "" },
              claude: { model: "", effort: "" },
            };
          else {
            res.statusCode = 404;
            data = { error: "Not part of the documentation preview" };
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        });
        const ws = new WebSocketServer({ noServer: true });
        server.httpServer.on("upgrade", (req, socket, head) => {
          if (req.url?.startsWith("/api/events?"))
            ws.handleUpgrade(req, socket, head, () => {});
        });
      },
    },
  ],
});
await preview.listen();
console.log("Read-only documentation preview: http://127.0.0.1:4178");
