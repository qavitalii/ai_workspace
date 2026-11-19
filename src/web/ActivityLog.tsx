import { useMemo, useState } from "react";
import {
  ArrowRightLeft,
  ChevronRight,
  CircleAlert,
  ListTree,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  describeActivity,
  mergeActivityEvents,
  type ActivityEvent,
  type ActivityKind,
} from "./activity-log";

export function ActivityLog({
  history,
  live,
  running,
}: {
  history: ActivityEvent[];
  live: ActivityEvent[];
  running: boolean;
}) {
  const [filter, setFilter] = useState<"all" | ActivityKind>("all");
  const events = useMemo(
    () => mergeActivityEvents(history, live),
    [history, live],
  );
  const recent = useMemo(
    () =>
      events.slice(-60).map((event) => ({ event, ...describeActivity(event) })),
    [events],
  );
  if (!events.length) return null;
  const counts = {
    all: recent.length,
    action: recent.filter((e) => e.kind === "action").length,
    output: recent.filter((e) => e.kind === "output").length,
    warning: recent.filter((e) => e.kind === "warning").length,
  };
  const visible = recent.filter((e) => filter === "all" || e.kind === filter);
  return (
    <details className="execution-log">
      <summary className="execution-log-heading">
        <span className="execution-log-mark">
          <ListTree size={17} />
        </span>
        <span className="execution-log-title">
          <strong>Actions and execution log</strong>
          <span>
            {counts.action} {counts.action === 1 ? "action" : "actions"} ·{" "}
            {counts.output} output {counts.output === 1 ? "entry" : "entries"}
            {counts.warning > 0 && (
              <span className="execution-warning-count">
                {" "}
                · {counts.warning}{" "}
                {counts.warning === 1 ? "warning" : "warnings"}
              </span>
            )}
          </span>
        </span>
        {running && <span className="execution-live">Live</span>}
        <ChevronRight size={16} className="execution-chevron" />
      </summary>
      <div className="execution-log-content">
        <div className="execution-toolbar">
          <div
            className="execution-filters"
            role="group"
            aria-label="Filter execution log"
          >
            {(
              [
                ["all", "All"],
                ["action", "Actions"],
                ["output", "Output"],
                ["warning", "Warnings"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {label}
                <span>{counts[key]}</span>
              </button>
            ))}
          </div>
          <span className="execution-order">
            {events.length > 60 ? "Latest 60 entries · " : ""}Oldest first
          </span>
        </div>
        <div className="execution-entries">
          {!visible.length && (
            <p className="execution-empty">
              No{" "}
              {filter === "action"
                ? "actions"
                : filter === "warning"
                  ? "warnings"
                  : "output entries"}{" "}
              in the recent log.
            </p>
          )}
          {visible.map(({ event, kind, title, preview, body, detailLabel }) => {
            const Icon =
              kind === "warning"
                ? CircleAlert
                : kind === "output"
                  ? Terminal
                  : event.type === "handoff"
                    ? ArrowRightLeft
                    : Wrench;
            const date = event.created_at ? new Date(event.created_at) : null;
            const validDate = date && !Number.isNaN(date.getTime());
            return (
              <details className={`execution-entry ${kind}`} key={event.id}>
                <summary>
                  <span className="execution-entry-icon">
                    <Icon size={15} />
                  </span>
                  <span className="execution-entry-text">
                    <strong>{title}</strong>
                    <span
                      className={kind === "warning" ? "" : "execution-preview"}
                    >
                      {preview}
                    </span>
                  </span>
                  {validDate && (
                    <time
                      dateTime={event.created_at}
                      title={date.toLocaleString()}
                    >
                      {date.toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  )}
                  <ChevronRight size={14} className="execution-chevron" />
                </summary>
                <div className="execution-entry-detail">
                  <span>{detailLabel}</span>
                  <pre>{body}</pre>
                </div>
              </details>
            );
          })}
        </div>
      </div>
    </details>
  );
}
