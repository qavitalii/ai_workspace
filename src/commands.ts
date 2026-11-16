import type { Provider } from "./shared.js";
export type ChatCommand = {
  name: string;
  description: string;
  native?: boolean;
  unavailable?: string;
};
const common: ChatCommand[] = [
  { name: "plan", description: "Switch to the agent’s planning mode" },
  { name: "model", description: "Choose model and reasoning effort" },
  { name: "permissions", description: "Choose approval settings" },
  { name: "rename", description: "Rename this chat" },
  {
    name: "status",
    description: "Show this chat’s account, model and run status",
  },
  {
    name: "compact",
    description: "Compact the current agent session",
    native: true,
  },
];
const workspace: ChatCommand[] = [
  { name: "settings", description: "Chat settings and connected folders" },
  { name: "files", description: "Browse workspace files" },
  { name: "terminal", description: "Open the terminal" },
  { name: "stop", description: "Stop this Workspace task" },
  { name: "help", description: "Commands supported by this integration" },
];
const unavailable = "Not available through this Workspace integration yet.";
export function commandsFor(
  provider: Provider,
  native: string[] = [],
): ChatCommand[] {
  const specific: ChatCommand[] =
    provider === "codex"
      ? [
          { name: "new", description: "Start a new chat" },
          { name: "diff", description: "Show workspace changes" },
          { name: "mention", description: "Insert a workspace file reference" },
          { name: "skills", description: "Choose a workspace skill" },
          {
            name: "review",
            description: "Review uncommitted workspace changes",
            native: true,
          },
          { name: "resume", description: "Choose a saved Workspace chat" },
          { name: "mcp", description: "Manage MCP servers", unavailable },
          { name: "apps", description: "Manage app connections", unavailable },
          { name: "fork", description: "Fork a native session", unavailable },
          {
            name: "fast",
            description: "Change native service tier",
            unavailable,
          },
        ]
      : [
          {
            name: "clear",
            description: "Start a new chat; keep this chat’s history",
          },
          {
            name: "usage",
            description: "Show usage information reported by the account",
          },
          {
            name: "context",
            description: "Inspect native context usage",
            native: true,
          },
          { name: "skills", description: "Choose a workspace skill" },
          { name: "resume", description: "Choose a saved Workspace chat" },
          ...[
            "init",
            "memory",
            "mcp",
            "plugin",
            "agents",
            "doctor",
            "config",
          ].map((name) => ({
            name,
            description: "Native Claude Code command",
            unavailable,
          })),
        ];
  const items = [...common, ...specific, ...workspace];
  if (provider === "claude") {
    // Only advertise native commands actually reported by this chat’s CLI session.
    for (const name of native.filter((n) => /^[a-zA-Z][\w:-]*$/.test(n))) {
      const existing = items.find((c) => c.name === name);
      if (existing?.unavailable) {
        existing.unavailable = undefined;
        existing.native = true;
      } else if (!existing)
        items.push({
          name,
          description: "Available in this Claude Code session",
          native: true,
        });
    }
    for (const item of items)
      if (item.native && !native.includes(item.name))
        item.unavailable =
          "Availability will be checked after the first message in this Claude Code session.";
  }
  return items;
}
export function slashCommand(text: string) {
  const m = text.trim().match(/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1], arguments: m[2] || "" } : null;
}
