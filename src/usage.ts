export type UsageWindow = {
  label: string;
  remaining: number | null;
  resetsAt: number | null;
  status?: string;
};
const number = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
const labels: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  seven_day_opus: "7 days · Opus",
  seven_day_sonnet: "7 days · Sonnet",
  overage: "Extra usage",
};
function duration(minutes: unknown, fallback: string) {
  if (!number(minutes) || minutes <= 0) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}
// Unknown utilization is not zero usage. A passed reset is not a fresh balance.
export function usageWindows(limits: any): UsageWindow[] {
  if (!limits || typeof limits !== "object") return [];
  const result: UsageWindow[] = [];
  function add(w: any, label: string) {
    if (!w || typeof w !== "object") return;
    const used = number(w.usedPercent)
      ? w.usedPercent
      : number(w.utilization)
        ? w.utilization * 100
        : null;
    result.push({
      label,
      remaining:
        used === null
          ? null
          : Math.round(Math.max(0, Math.min(100, 100 - used))),
      resetsAt: number(w.resetsAt)
        ? w.resetsAt
        : number(w.resets_at)
          ? w.resets_at
          : null,
      status: w.status,
    });
  }
  function snapshot(s: any, prefix = "") {
    if (s?.primary)
      add(
        s.primary,
        prefix + duration(s.primary.windowDurationMins, "Primary limit"),
      );
    if (s?.secondary)
      add(
        s.secondary,
        prefix + duration(s.secondary.windowDurationMins, "Secondary limit"),
      );
  }
  if (
    limits.rateLimitsByLimitId &&
    Object.keys(limits.rateLimitsByLimitId).length
  ) {
    for (const [id, s] of Object.entries<any>(limits.rateLimitsByLimitId))
      snapshot(s, `${s?.limitName || id} · `);
  } else if (limits.rateLimits) snapshot(limits.rateLimits);
  else if (limits.primary || limits.secondary) snapshot(limits);
  else if (limits.windows) {
    for (const [type, w] of Object.entries(limits.windows))
      add(w, labels[type] || type);
  } else
    add(
      limits,
      labels[limits.rateLimitType || limits.rate_limit_type] || "Usage limit",
    );
  return result;
}

export function modelLabel(chat: any) {
  // A reported model is valid only for the selection/account that produced it.
  const actual = chat?.resolved_model;
  return actual || chat?.model || "Model not yet reported";
}
export function effortLabel(effort: string) {
  const names: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
    ultra: "Ultra",
  };
  return names[effort] || (effort ? effort : "Effort not yet reported");
}
