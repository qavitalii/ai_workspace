// Local-only screenshot fixture. Never connects to a database or provider.
import {
  previewApprovals,
  previewResponses,
  handlePreviewInteraction,
} from "./preview-interactions.mjs";
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
const accounts = [
  {
    id: "demo-codex",
    name: "Studio Codex",
    provider: "codex",
    status: "ready",
    limits: {
      primary: { usedPercent: 18, windowDurationMins: 300 },
      secondary: { usedPercent: 32, windowDurationMins: 10080 },
    },
  },
  {
    id: "demo-claude",
    name: "Studio Claude",
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
const workspaces = [
  {
    id: "demo-main",
    project_id: "demo-project",
    name: "Main folder",
    kind: "main",
    status: "ready",
    initialized: true,
    storage_mode: "legacy",
    branch: "workspace/main",
    copy_exclusions: [],
  },
  {
    id: "demo-copy",
    project_id: "demo-project",
    name: "Mobile navigation",
    kind: "copy",
    status: "ready",
    initialized: true,
    storage_mode: "worktree",
    source_workspace_id: "demo-main",
    git_source_id: "demo-main",
    branch: "workspace/mobile-navigation",
    copy_exclusions: [],
  },
  {
    id: "demo-personal",
    project_id: null,
    name: "Release planning",
    kind: "personal",
    status: "ready",
    initialized: true,
    storage_mode: "folder",
    branch: "workspace/release-planning",
    copy_exclusions: [],
  },
];
const modelDefaults = {
  codex: { model: "gpt-5.4", effort: "high" },
  claude: { model: "sonnet", effort: "" },
};
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
for (const [index, chat] of chats.entries()) {
  const folder = workspaces[index];
  Object.assign(chat, {
    workspace_id: folder.id,
    workspace_name: folder.name,
    workspace_kind: folder.kind,
    branch: folder.branch,
    initialized: true,
  });
}
projects.push(
  {
    id: "demo-research",
    name: "Research and documentation for the next release",
    repo: "example/research",
    base_branch: "main",
  },
  { id: "demo-empty", name: "Ideas", repo: "", base_branch: "main" },
);
chats.push(
  ...[
    {
      id: "demo-queued",
      title: "Review the navigation and accessibility across all screens",
      state: "queued",
      provider: "codex",
      model: "gpt-5.4",
      account_id: "demo-codex",
    },
    {
      id: "demo-reply",
      title: "Confirm the release checklist",
      state: "waiting_approval",
      provider: "claude",
      model: "sonnet",
      account_id: "demo-claude",
    },
    {
      id: "demo-failed",
      title: "Check deployment configuration",
      state: "failed",
      provider: "codex",
      model: "gpt-5.4",
      account_id: "demo-codex",
    },
  ].map((chat) => ({
    ...chat,
    project_id: "demo-research",
    workspace_id: "demo-main",
    workspace_name: "Main folder",
    workspace_kind: "main",
    initialized: true,
  })),
);
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
    provider: "codex",
    content:
      "The setup guide is ready to review.\n\n### Changes\n- Added a three-step checklist.\n- Separated setup from troubleshooting.\n- Fixed the deployment links.\n\nBuild and link checks passed. Open **Changes** to review the diff.",
    created_at: "2026-11-16T09:42:00Z",
  },
];
const activity = [
  { type: "tool", data: { item: { type: "file_change", path: "README.md" } } },
  {
    type: "tool",
    data: { item: { type: "command_execution", command: "npm test" } },
  },
  {
    type: "log",
    data: {
      text: "✓ Setup links resolve\n✓ Deployment links resolve\n\n2 checks passed",
    },
  },
].map((event, index) => ({
  ...event,
  id: index + 1,
  created_at: `2026-11-16T09:41:0${index}Z`,
}));
const localDiff = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,5 +1,9 @@",
  "-# Setup",
  "+# Getting started",
  " ",
  "-Run the installation script.",
  "+Set up your workspace in three steps:",
  "+",
  "+1. Connect your agent account.",
  "+2. Choose a working folder.",
  "+3. Start your first chat.",
  " ",
  " See the deployment guide for more options.",
  "diff --git a/src/navigation.ts b/src/navigation.ts",
  "--- a/src/navigation.ts",
  "+++ b/src/navigation.ts",
  "@@ -4,4 +4,4 @@",
  " export const navigation = {",
  '-  label: "Setup",',
  '+  label: "Getting started",',
  '   href: "/docs/start",',
  " };",
  "",
].join("\n");
const workingCopyReview = {
  id: "demo-copy-review",
  changes: [
    {
      path: "docs/navigation.md",
      status: "modified",
      conflict: true,
      main: "# Navigation\n\nKeep the primary links visible on desktop.",
      copy: "# Navigation\n\nCollapse primary links into a menu on phones.",
    },
  ],
  excluded: [],
};
const sampleSkill = {
  name: "project-review",
  description:
    "Review project changes and summarize the checks to run before publishing.",
  hints: [],
  fileCount: 2,
  revision: "demo-skill",
};
const preview = await createServer({
  configFile: false,
  server: { host: "127.0.0.1", port: 4178, strictPort: true },
  plugins: [
    {
      name: "documentation-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
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
          if (await handlePreviewInteraction(req, res, path)) return;
          let data;
          if (
            req.method === "POST" &&
            path === "/api/workspaces/demo-copy/review"
          )
            data = workingCopyReview;
          else if (
            req.method === "POST" &&
            path === "/api/chats/demo-chat/publication-review"
          )
            data = {
              diff: localDiff,
              pushDiff: "",
              commits: "",
              pushError: "",
              review_token: "demo-review-only",
            };
          else if (
            req.method === "POST" &&
            /^\/api\/accounts\/demo-[^/]+\/models$/.test(path)
          ) {
            data = [
              {
                id: "gpt-5.4",
                model: "gpt-5.4",
                isDefault: true,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: [
                  { reasoningEffort: "medium" },
                  { reasoningEffort: "high" },
                  { reasoningEffort: "xhigh" },
                ],
              },
            ];
          } else if (req.method !== "GET") {
            res.statusCode = 405;
            data = { error: "Read-only documentation preview" };
          } else if (path === "/api/me")
            data = { ok: true, maxAttachments: 10, maxFileBytes: 26214400 };
          else if (path === "/api/search") {
            const query =
              new URL(req.url, "http://localhost").searchParams
                .get("q")
                ?.toLowerCase() || "";
            data = chats.filter(
              (c) =>
                c.title.toLowerCase().includes(query) ||
                (query === "setup" && c.id === "demo-chat"),
            );
          } else if (path === "/api/overview")
            data = { accounts, projects, chats, workspaces, modelDefaults };
          else if (path === "/api/projects/demo-project/workspaces")
            data = workspaces.filter((w) => w.project_id === "demo-project");
          else if (chats.some((c) => path === "/api/chats/" + c.id))
            data = {
              chat: chats.find((c) => path === "/api/chats/" + c.id),
              messages: [
                ...(path.endsWith("demo-review")
                  ? []
                  : path.endsWith("demo-notes")
                    ? Array.from({ length: 8 }, (_, i) => ({
                        id: "history-" + i,
                        role: i % 2 ? "assistant" : "user",
                        content:
                          i % 2
                            ? '### Release checklist\n\n- Review the navigation and layout.\n- Check the mobile experience.\n- Confirm the release notes.\n\n```ts\nexport const release = { ready: true, version: "1.0.0" };\n```\n\n| Area | Status |\n| --- | --- |\n| Navigation | Ready |\n| Mobile layout | Reviewed |\n\n> Keep the release focused on the changes we reviewed.'
                            : "Review the release plan and summarize what is ready.",
                        created_at: "2026-11-16T09:40:00Z",
                      }))
                    : messages),
                ...previewResponses(path.split("/").at(-1)),
              ],
              attachments: [],
              jobs: [],
              approvals: previewApprovals(path.split("/").at(-1)),
              events: path.endsWith("demo-chat") ? activity : [],
            };
          else if (/^\/api\/chats\/[^/]+\/context$/.test(path))
            data = {
              initialized: true,
              entries: [
                {
                  kind: "file",
                  name: "README.md",
                  path: "/workspace/README.md",
                },
                {
                  kind: "skill",
                  name: "project-review",
                  path: "/workspace/skills/project-review/SKILL.md",
                },
              ],
            };
          else if (path === "/api/system")
            data = {
              maxConcurrent: 3,
              running: 0,
              queued: 0,
              waitingAccounts: 0,
              output: {
                usedBytes: 125000000,
                limitGb: 1,
                limitBytes: 1000000000,
              },
              resources: {
                scope: "Docker Desktop VM",
                sampledAt: new Date().toISOString(),
                cpu: { cores: 8, usedPercent: 12, availablePercent: 88 },
                memory: {
                  usedBytes: 3 * 1024 ** 3,
                  totalBytes: 8 * 1024 ** 3,
                  availableBytes: 5 * 1024 ** 3,
                },
                disk: {
                  usedBytes: 32 * 1024 ** 3,
                  totalBytes: 128 * 1024 ** 3,
                  availableBytes: 96 * 1024 ** 3,
                },
              },
            };
          else if (path === "/api/folders")
            data = { folders: ["Reference files", "Brand assets"] };
          else if (/^\/api\/(projects|chats)\/[^/]+\/folders$/.test(path))
            data = path.includes("demo-personal")
              ? []
              : [
                  {
                    id: "demo-reference",
                    name: "Reference files",
                    read_only: true,
                    inherited: path.includes("/chats/"),
                  },
                  {
                    id: "demo-assets",
                    name: "Brand assets",
                    read_only: false,
                    inherited: false,
                  },
                ];
          else if (/^\/api\/workspaces\/[^/]+\/attachments$/.test(path))
            data = [
              {
                id: "demo-brief",
                name: "Project brief.txt",
                chat_title: "Getting started",
              },
            ];
          else if (
            /^\/api\/(workspaces|chats|folders)\/[^/]+\/files$/.test(path)
          ) {
            const dir =
              new URL(req.url, "http://localhost").searchParams.get("path") ||
              "";
            const entries = {
              "": [
                ["src", true],
                ["docs", true],
                ["README.md", false],
                ["package.json", false],
                ["design-notes.txt", false],
              ],
              src: [
                ["components", true],
                ["navigation.ts", false],
              ],
              "src/components": [["Header.tsx", false]],
              docs: [
                ["archive", true],
                ["empty.txt", false],
                ["preview-error.txt", false],
                ["sample.bin", false],
                ["large.txt", false],
              ],
              "docs/archive": [],
            };
            data = (entries[dir] || []).map(([name, directory]) => ({
              name,
              path: (dir ? dir + "/" : "") + name,
              directory,
            }));
          } else if (/^\/api\/(workspaces|chats)\/[^/]+\/file$/.test(path)) {
            const file =
              new URL(req.url, "http://localhost").searchParams.get("path") ||
              "";
            res.setHeader("Content-Type", "text/plain");
            if (file.endsWith("preview-error.txt")) {
              res.statusCode = 500;
              res.end("Preview fixture error");
            } else if (file.endsWith("sample.bin")) res.end("Binary\0fixture");
            else if (file.endsWith("large.txt"))
              res.end("Long document line\n".repeat(12000));
            else if (file.endsWith("empty.txt")) res.end("");
            else if (file.endsWith("navigation.ts"))
              res.end(
                'export const navigation = [\n  { label: "Getting started", href: "/docs/start" },\n  { label: "Projects", href: "/projects" },\n];\n',
              );
            else
              res.end(
                "# Studio website\n\nA shared workspace for the studio team.\n\n## Getting started\n\n1. Connect your agent account.\n2. Choose a working folder.\n3. Start your first chat.\n\n## Project structure\n\n- src/ — application components\n- docs/ — guides and project notes\n\nFiles in this folder are shared across your chats. You can review changes before publishing them.\n",
              );
            return;
          } else if (/^\/api\/chats\/[^/]+\/diff$/.test(path))
            data = { diff: localDiff, untracked: [] };
          else if (/^\/api\/workspaces\/[^/]+\/deletion$/.test(path))
            data = { chats: [], attachments: 0 };
          else if (path === "/api/ssh-keys")
            data = [
              {
                id: "demo-key",
                name: "Deployment key",
                fingerprint: "SHA256:example-fingerprint-for-documentation",
                public_key: "ssh-ed25519 EXAMPLE_PUBLIC_KEY_FOR_DOCUMENTATION",
              },
            ];
          else if (path === "/api/servers")
            data = [
              {
                id: "demo-server",
                name: "Production server",
                alias: "production",
                host: "server.example.com",
                port: 22,
                username: "deploy",
                key_id: "demo-key",
                host_keys: [],
                last_checked_at: null,
              },
            ];
          else if (/^\/api\/(projects|chats)\/[^/]+\/servers$/.test(path))
            data = {
              inherited: path.includes("/chats/"),
              server_ids: ["demo-server"],
            };
          else if (path === "/api/projects/demo-project/aws")
            data = { settings: null, identity: null, pending: false };
          else if (path === "/api/skills") data = [sampleSkill];
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
          else if (/^\/api\/chats\/[^/]+\/terminal$/.test(req.url || ""))
            ws.handleUpgrade(req, socket, head, (client) => {
              client.send(
                JSON.stringify({
                  type: "terminal",
                  data: "Preview terminal — no commands are executed.\r\nworkspace $ ",
                }),
              );
            });
        });
      },
    },
  ],
});
await preview.listen();
console.log("Read-only documentation preview: http://127.0.0.1:4178");
