import { useEffect, useState } from "react";
import { RefreshCw, ChevronDown } from "lucide-react";
import { usageWindows } from "../usage";
import { api } from "./api";
import { ProviderIcon } from "./ProviderIcon";

const AUTO_INTERVAL = 5 * 60 * 1000;
const lastAttempt = new Map<string, number>();

export function AccountUsage({
  account,
  refresh,
  compact = false,
  sidebar = false,
  autoRefresh = false,
}: any) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false);
  const idle = !!account && ["ready", "limited"].includes(account.status);
  async function load(quiet = false) {
    if (!account) return;
    lastAttempt.set(account.id, Date.now());
    setBusy(true);
    setError("");
    try {
      await api(`/accounts/${account.id}/usage`, {});
      await refresh?.();
    } catch (e: any) {
      if (!quiet) setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Refresh stale limits when the panel is opened, at most once per interval.
  useEffect(() => {
    if (!autoRefresh || !idle || !refresh || busy) return;
    const updated = account.limits_updated_at
      ? new Date(account.limits_updated_at).getTime()
      : 0;
    const expired = usageWindows(account.limits).some(
      (w) => w.resetsAt !== null && w.resetsAt * 1000 <= Date.now(),
    );
    const now = Date.now();
    if (now - (lastAttempt.get(account.id) ?? 0) < AUTO_INTERVAL) return;
    if (!expired && now - updated < AUTO_INTERVAL) return;
    void load(true);
  }, [autoRefresh, idle, account?.id, account?.limits_updated_at]);
  if (!account) return null;
  const windows = usageWindows(account.limits);
  return (
    <section
      className={
        "account-usage " +
        (compact ? "compact" : "") +
        (sidebar ? " sidebar-meter" : "")
      }
      aria-label={account.name + " usage limits"}
    >
      <div className="usage-heading">
        <strong className="usage-account" title={account.name}>
          <ProviderIcon provider={account.provider} size={14} />
          {account.name}
        </strong>
        <span>{account.provider === "codex" ? "Codex" : "Claude Code"}</span>
        {refresh && (
          <button
            type="button"
            className="icon"
            disabled={busy || !idle}
            aria-label={"Refresh limits for " + account.name}
            title="Refresh limits"
            onClick={() => load()}
          >
            <RefreshCw size={14} className={busy ? "spin" : ""} />
          </button>
        )}
      </div>
      {compact && (
        <button
          type="button"
          className="usage-summary"
          aria-expanded={expanded}
          aria-label={
            compact
              ? `Limits for ${account.name}: ${windows.length ? windows.map((w) => `${w.label}, ${w.resetsAt && w.resetsAt * 1000 <= Date.now() ? "awaiting update" : w.remaining === null ? "not reported" : `${w.remaining}% left`}`).join("; ") : "not reported"}. ${expanded ? "Hide" : "Show"} details`
              : undefined
          }
          onClick={() => setExpanded(!expanded)}
        >
          {windows.length ? (
            windows.map((w, i) => (
              <span key={i} title={w.label}>
                {compact
                  ? w.label
                      .replace(/^codex · /i, "")
                      .replace(/ hours?\b/, "h")
                      .replace(/ days?\b/, "d")
                      .replace(/ minutes?\b/, "m")
                  : w.label}
                :{" "}
                <strong>
                  {w.resetsAt && w.resetsAt * 1000 <= Date.now()
                    ? sidebar
                      ? "Updating"
                      : "Awaiting update"
                    : w.remaining === null
                      ? sidebar
                        ? "—"
                        : "Not reported"
                      : `${w.remaining}%${sidebar ? "" : " left"}`}
                </strong>
              </span>
            ))
          ) : (
            <span title="Remaining limit not reported yet">
              {sidebar ? "No data" : "Remaining limit not reported yet"}
            </span>
          )}
          {sidebar ? (
            <ChevronDown
              size={12}
              aria-hidden="true"
              style={{ transform: expanded ? "rotate(180deg)" : undefined }}
            />
          ) : (
            <span className="usage-details-label">
              {expanded ? "Hide details" : "Details"}
            </span>
          )}
        </button>
      )}
      {account.status === "limited" && (
        <strong className="usage-warning">Account limit reached</strong>
      )}
      {(!compact || expanded) && (
        <>
          {!windows.length && <small>Remaining limit not reported yet.</small>}
          {windows.map((w, i) => {
            const expired =
              w.resetsAt !== null && w.resetsAt * 1000 <= Date.now();
            return (
              <div className="usage-window" key={w.label + i}>
                <div>
                  <span>{w.label}</span>
                  <strong>
                    {expired
                      ? "Awaiting update"
                      : w.remaining === null
                        ? w.status === "rejected"
                          ? "Limit reached"
                          : "Not reported"
                        : `${w.remaining}% left`}
                  </strong>
                </div>
                {w.remaining !== null && !expired && (
                  <progress
                    className={w.remaining <= 20 ? "low" : ""}
                    aria-label={`${account.name}: ${w.label} remaining`}
                    max={100}
                    value={w.remaining}
                  />
                )}
                {w.remaining === null && w.status === "allowed_warning" && (
                  <small>Approaching the limit</small>
                )}
                {w.resetsAt !== null && (
                  <small>
                    {expired ? "Reset was due " : "Resets "}
                    <time dateTime={new Date(w.resetsAt * 1000).toISOString()}>
                      {new Date(w.resetsAt * 1000).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </small>
                )}
              </div>
            );
          })}
          {account.limits_updated_at && (
            <small>
              Last reported{" "}
              {new Date(account.limits_updated_at).toLocaleString([], {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </small>
          )}
          {!compact && account.provider === "claude" && (
            <small>
              Refresh reads current limits without starting a task. During a
              task, Claude's own reports update them; some omit a percentage.
            </small>
          )}
        </>
      )}
      {error && (
        <small role="alert" className="usage-warning">
          {error}
        </small>
      )}
    </section>
  );
}
