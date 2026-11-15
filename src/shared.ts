export type Provider = "codex" | "claude";
export type RunState =
  | "queued"
  | "running"
  | "waiting_approval"
  | "waiting_account"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";
export type AgentEvent = { type: string; [key: string]: any };
export type RunInput = {
  provider: Provider;
  prompt: string;
  model?: string;
  effort?: string;
  autonomous: boolean;
  sessionId?: string;
  attachments: { path: string; mime: string }[];
};
export type RunnerCommand =
  | { type: "start"; input: RunInput }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "stop" }
  | { type: "terminal"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "auth"; provider: Provider }
  | { type: "auth_input"; data: string }
  | { type: "models"; provider: Provider };
export function quotaError(code: unknown): boolean {
  return [
    "usage_limit_reached",
    "rate_limit_exceeded",
    "rate_limit_error",
    "insufficient_quota",
  ].includes(String(code));
}
export function validRepo(value: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) &&
    !value.split("/").some((x) => x === "." || x === "..")
  );
}

export function cleanTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function claudeSignInUrl(value: string): string | undefined {
  return cleanTerminalText(value).match(
    /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[^\s\x00-\x1f]+/,
  )?.[0];
}

export function attachmentNotice(mime: string, name: string): string {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime))
    return "";
  if (mime.startsWith("image/"))
    return "Image input requires PNG, JPEG, WebP or GIF. Convert this image before asking the agent to view it.";
  if (/\.(zip|tar|gz|7z|rar|bz2|xz)$/i.test(name))
    return "Stored as a file. Archives are not extracted automatically.";
  if (
    mime.startsWith("text/") ||
    /\.(txt|md|json|csv|ts|tsx|js|jsx|py|sh|yaml|yml|toml|xml|html|css|sql|rs|go|java|c|h|cpp)$/i.test(
      name,
    )
  )
    return "";
  return "Available as a file path. Reading this format may require additional tools in the workspace.";
}
