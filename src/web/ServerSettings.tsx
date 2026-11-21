import { useEffect, useState, useRef } from "react";
import { api } from "./api";
import { Metric, resourceBytes as bytes } from "./ResourceMetric";
export function ServerSettings() {
  const [system, setSystem] = useState<any>(null);
  const [maximum, setMaximum] = useState("");
  const [outputLimit, setOutputLimit] = useState("");
  const [outputSaving, setOutputSaving] = useState(false);
  const [outputResult, setOutputResult] = useState("");
  const [outputError, setOutputError] = useState("");
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
            setOutputLimit(String(data.output.limitGb));
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
      <header className="workspace-settings-heading">
        <div className="resources-heading">
          <h3>Resources</h3>
          <span>{offline ? "Connection lost" : "Updates every 2 seconds"}</span>
        </div>
        <p className="muted">
          Monitor usage and set limits for your workspace.
        </p>
      </header>
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
      <div className="resource-settings">
        {system?.output && (
          <form
            className="execution-settings workspace-settings-card"
            onSubmit={async (e) => {
              e.preventDefault();
              if (outputSaving) return;
              setOutputSaving(true);
              setOutputError("");
              setOutputResult("");
              try {
                const output = await api("/settings/output", {
                  limitGb: Number(outputLimit),
                });
                setSystem((old: any) => ({ ...old, output }));
                setOutputResult(
                  "Saved. Existing history is kept; tasks stop if new output would exceed this limit.",
                );
              } catch (e: any) {
                setOutputError(e.message);
              } finally {
                setOutputSaving(false);
              }
            }}
          >
            <header className="settings-card-heading">
              <h4>Output storage</h4>
            </header>
            <label className="field">
              <span>Limit (GB, all chats)</span>
              <input
                type="number"
                min="0.01"
                max="10000"
                step="0.01"
                required
                value={outputLimit}
                onChange={(e) => {
                  setOutputLimit(e.target.value);
                  setOutputResult("");
                }}
                aria-describedby="output-limit-help"
              />
            </label>
            <Metric
              label="Saved agent output"
              value={`${(system.output.usedBytes / 1e9).toFixed(3)} GB used`}
              detail={`Shared limit: ${system.output.limitGb} GB`}
              percent={Math.min(
                100,
                (system.output.usedBytes / system.output.limitBytes) * 100,
              )}
            />
            <p className="muted">
              Tasks stop at this limit. Existing history is kept.
            </p>
            <details className="help-details">
              <summary>What counts toward the limit?</summary>
              <p id="output-limit-help" className="muted">
                Includes saved responses, activity, approval details and
                conversation summaries. 1 GB = 1,000,000,000 bytes. Project
                files, attachments, provider histories and database overhead use
                additional disk space. At the limit, increase it or delete old
                chats to make room. Existing history is never deleted
                automatically.
              </p>
            </details>
            {system.output.usedBytes >= system.output.limitBytes && (
              <p role="alert" className="inline-error">
                Output storage is full. Increase the limit or delete old chats
                before continuing.
              </p>
            )}
            <div className="settings-card-actions">
              <button className="primary" disabled={outputSaving}>
                {outputSaving ? "Saving…" : "Save output limit"}
              </button>
            </div>
            {outputError && (
              <p role="alert" className="inline-error">
                {outputError}
              </p>
            )}
            {outputResult && (
              <p role="status" className="success">
                {outputResult}
              </p>
            )}
          </form>
        )}
        <form
          className="execution-settings workspace-settings-card"
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
          <header className="settings-card-heading">
            <h4>Task capacity</h4>
          </header>
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
            Each task needs an available account and enough server capacity. One
            task runs per account.
          </p>
          {system && (
            <p className="muted">
              Current limit: {system.maxConcurrent} ·{" "}
              {Math.max(0, system.maxConcurrent - system.running)} execution
              slots free
            </p>
          )}
          <div className="settings-card-actions">
            <button className="primary" disabled={saving || !system}>
              {saving ? "Saving…" : "Save capacity"}
            </button>
          </div>
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
        {typeof system?.projectEnvLimitGib === "number" && (
          <ProjectToolsLimit
            limit={system.projectEnvLimitGib}
            onSaved={(value) =>
              setSystem((old: any) => ({ ...old, projectEnvLimitGib: value }))
            }
          />
        )}
      </div>
    </section>
  );
}

function ProjectToolsLimit({
  limit,
  onSaved,
}: {
  limit: number;
  onSaved: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="execution-settings workspace-settings-card"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setError("");
        setFeedback("");
        const value = Number(draft ?? limit);
        if (!Number.isFinite(value) || value <= 0) {
          setError("Enter a positive size in GiB.");
          return;
        }
        setSaving(true);
        try {
          const saved = await api<{ projectEnvLimitGib: number }>(
            "/settings/environment",
            { projectEnvLimitGib: value },
          );
          onSaved(saved.projectEnvLimitGib);
          setDraft(null);
          setFeedback("Limit saved.");
        } catch (error) {
          setError((error as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <header className="settings-card-heading">
        <h4>Project tools</h4>
      </header>
      <label className="field">
        <span>Limit (GiB per project)</span>
        <input
          type="number"
          min={0}
          step="any"
          required
          disabled={saving}
          value={draft ?? String(limit)}
          onChange={(event) => {
            setDraft(event.target.value);
            setFeedback("");
            setError("");
          }}
          aria-describedby="project-tools-limit-help"
        />
      </label>
      <p id="project-tools-limit-help" className="muted">
        Applies to new sessions. Over the limit, installed tools are read-only.
      </p>
      <div className="settings-card-actions">
        <button className="primary" disabled={saving}>
          {saving ? "Saving…" : "Save project tools limit"}
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {feedback && (
        <p className="success" role="status">
          {feedback}
        </p>
      )}
    </form>
  );
}
