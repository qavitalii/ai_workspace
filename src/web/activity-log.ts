import { cleanTerminalText } from "../shared";

export type ActivityEvent = {
  id: string | number;
  job_id?: string | null;
  type: string;
  created_at?: string;
  data: Record<string, unknown>;
};
export type ActivityKind = "action" | "output" | "warning";

// A refresh and the live stream can contain the same events. Keep history visible
// when the first live event arrives and compare database IDs without Number loss.
export function mergeActivityEvents(
  history: ActivityEvent[],
  live: ActivityEvent[],
) {
  const events = new Map<string, ActivityEvent>();
  for (const event of [...history, ...live]) {
    if (["tool", "log", "handoff", "warning"].includes(event.type))
      events.set(String(event.id), event);
  }
  return [...events.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id), "en", { numeric: true }),
  );
}

export function recentActivityEvents(
  events: ActivityEvent[],
  limit: number,
  startupJobId?: string | null,
) {
  if (events.length <= limit) return events;
  if (startupJobId === undefined) {
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index].data.projectPackageStartup === true) {
        startupJobId = events[index].job_id;
        break;
      }
    }
  }
  return events.filter(
    (event, index) =>
      index >= events.length - limit ||
      (startupJobId != null &&
        event.job_id === startupJobId &&
        event.data.projectPackageStartup === true),
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? cleanTerminalText(value) : "";
}
function readableName(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/.-]+/g, " ");
}

export function describeActivity(event: ActivityEvent): {
  kind: ActivityKind;
  title: string;
  preview: string;
  body: string;
  detailLabel: string;
} {
  const data = event.data;
  const item = object(data.item);
  const input = object(item.input);
  const fallback = JSON.stringify(data.item ?? data, null, 2);
  if (event.type === "log") {
    const body = text(data.text) || fallback;
    return {
      kind: "output",
      title: "Command output",
      preview: body.trim().split("\n")[0],
      body,
      detailLabel: "Output",
    };
  }
  if (event.type === "warning" || event.type === "handoff") {
    const body = text(data.message) || fallback;
    return {
      kind: event.type === "warning" ? "warning" : "action",
      title: event.type === "warning" ? "Warning" : "Account switched",
      preview: body,
      body,
      detailLabel: "Details",
    };
  }
  const command = text(item.command) || text(input.command);
  const name = text(item.name) || text(item.type) || "Agent action";
  const titles: Record<string, string> = {
    commandExecution: "Run command",
    command_execution: "Run command",
    Bash: "Run command",
    fileChange: "Edit files",
    file_change: "Edit files",
    Edit: "Edit file",
    Write: "Write file",
    Read: "Read file",
    Glob: "Find files",
    Grep: "Search files",
    webSearch: "Search the web",
    mcpToolCall: "Use connected tool",
    reasoning: "Reasoning",
    plan: "Update plan",
  };
  const title = titles[name] || readableName(name);
  const changedPaths = Array.isArray(item.changes)
    ? item.changes
        .map((change) => text(object(change).path))
        .filter(Boolean)
        .join(", ")
    : "";
  const preview =
    command ||
    text(input.file_path) ||
    text(item.path) ||
    changedPaths ||
    text(input.pattern) ||
    text(item.query) ||
    text(item.tool) ||
    "Expand to inspect this action";
  // Keep the complete original event available, including fields not yet recognized.
  return {
    kind: "action",
    title,
    preview,
    body: fallback,
    detailLabel: "Action details",
  };
}
