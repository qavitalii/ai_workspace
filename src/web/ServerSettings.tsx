import { useEffect, useState, useRef } from "react";
import { api } from "./api";

function bytes(n: number) {
  const unit = n >= 1024 ** 4 ? "TiB" : n >= 1024 ** 3 ? "GiB" : "MiB";
  const size =
    unit === "TiB" ? 1024 ** 4 : unit === "GiB" ? 1024 ** 3 : 1024 ** 2;
  return `${(n / size).toFixed(1)} ${unit}`;
}
function Metric({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number | null;
}) {
  return (
    <div className="resource-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {typeof percent === "number" && (
        <progress aria-label={label + " usage"} value={percent} max={100} />
      )}
      <small>{detail}</small>
    </div>
  );
}
export function ServerSettings() {
  const [system, setSystem] = useState<any>(null);
  const [maximum, setMaximum] = useState("");
  const initialized = useRef(false);
  const [offline, setOffline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true,
      busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        const data = await api("/system");
        if (live) {
          setSystem(data);
          if (!initialized.current) {
            initialized.current = true;
            setMaximum(String(data.maxConcurrent));
          }
          setOffline(false);
        }
      } catch {
        if (live) setOffline(true);
      } finally {
        busy = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const r = system?.resources;
  return (
    <section aria-label="Server resources">
      <div className="resources-heading">
        <h3>Resources</h3>
        <span>{offline ? "Connection lost" : "Updates every 2 seconds"}</span>
      </div>
      {offline && (
        <p className="inline-error" role="status">
          {system
            ? "Showing the last sample. Reconnecting…"
            : "Unable to load resources. Reconnecting…"}
        </p>
      )}
      {!r && !offline && <p className="muted">Loading resources…</p>}
      {r && (
        <>
          <p className="muted">
            {r.scope} · {r.cpu.cores} CPU cores. Usage includes other
            applications.
          </p>
          <div className="resource-grid">
            <Metric
              label="CPU"
              value={
                r.cpu.usedPercent === null
                  ? "Collecting…"
                  : `${r.cpu.usedPercent}% used`
              }
              percent={r.cpu.usedPercent}
              detail={
                r.cpu.availablePercent === null
                  ? "Waiting for a second sample"
                  : `${r.cpu.availablePercent}% idle`
              }
            />
            <Metric
              label="Memory"
              value={
                r.memory ? `${bytes(r.memory.usedBytes)} used` : "Unavailable"
              }
              percent={
                r.memory
                  ? (r.memory.usedBytes / r.memory.totalBytes) * 100
                  : null
              }
              detail={
                r.memory
                  ? `${bytes(r.memory.availableBytes)} available of ${bytes(r.memory.totalBytes)}`
                  : "Memory information is unavailable"
              }
            />
            <Metric
              label="Workspace disk"
              value={
                r.disk ? `${bytes(r.disk.availableBytes)} free` : "Unavailable"
              }
              percent={
                r.disk ? (r.disk.usedBytes / r.disk.totalBytes) * 100 : null
              }
              detail={
                r.disk
                  ? `${bytes(r.disk.usedBytes)} used of ${bytes(r.disk.totalBytes)}`
                  : r.diskNote
              }
            />
            <Metric
              label="Tasks"
              value={`${system.running} running`}
              detail={`${system.queued} queued · ${system.waitingAccounts} waiting for an account`}
            />
          </div>
          {r.scope === "Docker Desktop VM" && (
            <p className="muted">
              CPU and memory reflect Docker's virtual machine. Check your
              computer's settings for physical disk space.
            </p>
          )}
          <p className="resource-updated">
            Updated {new Date(r.sampledAt).toLocaleTimeString("en-GB")}
          </p>
        </>
      )}
      <form
        className="execution-settings"
        onSubmit={async (e) => {
          e.preventDefault();
          if (saving) return;
          const value = Number(maximum);
          if (!Number.isSafeInteger(value) || value < 1) {
            setError("Enter a positive whole number.");
            return;
          }
          setSaving(true);
          setError("");
          setResult("");
          try {
            const saved = await api("/settings/execution", {
              maxConcurrent: value,
            });
            setSystem((old: any) =>
              old ? { ...old, maxConcurrent: saved.maxConcurrent } : old,
            );
            setResult(
              "Saved. New starts use this limit; running tasks continue.",
            );
          } catch (e: any) {
            setError(e.message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label className="field">
          <span>Maximum concurrent tasks</span>
          <input
            type="number"
            min={1}
            step={1}
            required
            value={maximum}
            onChange={(e) => {
              setMaximum(e.target.value);
              setResult("");
            }}
            aria-describedby="concurrency-help"
          />
        </label>
        <p id="concurrency-help" className="muted">
          Choose any positive whole number, including 50 or more. Each task
          needs an available account and server resources. One task runs per
          account.
        </p>
        {system && (
          <p className="muted">
            Current limit: {system.maxConcurrent} ·{" "}
            {Math.max(0, system.maxConcurrent - system.running)} execution slots
            free
          </p>
        )}
        <button className="primary" disabled={saving || !system}>
          {saving ? "Saving…" : "Save capacity"}
        </button>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="success" role="status">
            {result}
          </p>
        )}
      </form>
    </section>
  );
}
