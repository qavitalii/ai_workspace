import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, RefreshCw } from "lucide-react";
import { version as clientVersion } from "../../package.json";
import { api } from "./api";

type Release = { version: string; commit: string };
type UpdateStatus = {
  installed: string;
  updater: "disabled" | "offline" | "ready";
  phase: "idle" | "waiting" | "updating" | "succeeded" | "failed";
  available: Release | null;
  target: Release | null;
  checkedAt: number | null;
  checkFailed: boolean;
  checking?: boolean;
  message: string | null;
};

export function useWorkspaceUpdates(enabled: boolean, watching: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const checkingRef = useRef(false);
  const reload = useRef(() => {});
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setConnectionLost(false);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Only the latest request may update state or schedule the next poll, so
    // a reload never leaves a second polling loop or applies a stale result.
    let sequence = 0;
    reload.current = () => {
      clearTimeout(timer);
      void load();
    };
    async function load() {
      const mine = ++sequence;
      try {
        const next = await api<UpdateStatus>("/updates");
        if (stopped || mine !== sequence) return;
        checkingRef.current = !!next.checking;
        setStatus(next);
        setConnectionLost(false);
      } catch {
        if (!stopped && mine === sequence) setConnectionLost(true);
      } finally {
        if (!stopped && mine === sequence)
          timer = setTimeout(
            load,
            watching ? 3500 : checkingRef.current ? 2000 : 60_000,
          );
      }
    }
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, watching]);
  async function schedule(release: Release) {
    await api("/updates", release);
    setStatus((current) =>
      current ? { ...current, phase: "waiting", target: release } : current,
    );
  }
  async function check() {
    await api("/updates/check", {});
    checkingRef.current = true;
    setStatus((current) =>
      current ? { ...current, checking: true } : current,
    );
    reload.current();
  }
  return { status, connectionLost, schedule, check };
}

export function UpdateSettings({
  status,
  connectionLost,
  schedule,
  check,
}: ReturnType<typeof useWorkspaceUpdates>) {
  const [sending, setSending] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState("");
  const busy = status?.phase === "waiting" || status?.phase === "updating";
  const target = status?.target?.version ?? status?.available?.version;

  async function install(release: Release) {
    setSending(true);
    setError("");
    try {
      await schedule(release);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function checkNow() {
    setRequesting(true);
    setError("");
    try {
      await check();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRequesting(false);
    }
  }

  const checking = requesting || !!status?.checking;
  let message = "Checking for updates…";
  if (status?.phase === "updating")
    message = `Installing Workspace ${target ?? ""}. This page will reconnect after the server restarts.`;
  else if (connectionLost) message = "Trying to reconnect to Workspace…";
  else if (status?.updater === "disabled")
    message =
      "Browser updates are available on Linux servers with the update service enabled.";
  else if (status?.updater === "offline")
    message = "The server’s update service is temporarily unavailable.";
  else if (checking && !busy) message = "Checking for updates…";
  else if (status?.phase === "waiting")
    message =
      "Update scheduled. Finish running tasks and close open terminals. Queued tasks will resume afterward.";
  else if (status?.message) message = status.message;
  else if (status?.available)
    message = `Workspace ${status.available.version} is available. Workspace will back up your data before restarting.`;
  else if (status?.phase === "succeeded")
    message = `Workspace ${status.installed} was installed successfully.`;
  else if (status?.checkFailed)
    message =
      "The server couldn’t check for releases. It will try again automatically.";
  else if (status?.checkedAt) message = "Workspace is up to date.";

  const reloadNeeded =
    status?.phase === "succeeded" &&
    status.installed !== `v${clientVersion}` &&
    !connectionLost;
  const canCheck =
    status?.updater === "ready" && !busy && !connectionLost && !reloadNeeded;
  // Kept visible while checking so the dialog does not change height.
  const lastChecked = status?.checkedAt
    ? new Date(status.checkedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;
  const available =
    status?.updater === "ready" &&
    !status.checkFailed &&
    !busy &&
    !connectionLost
      ? status.available
      : null;
  return (
    <>
      <header className="workspace-settings-heading">
        <h3>Updates</h3>
      </header>
      <section
        className="workspace-settings-card"
        aria-label="Workspace version"
      >
        <header className="settings-card-heading">
          <h4>Installed version</h4>
          {status && <span>{status.installed}</span>}
        </header>
        <p className="muted" role="status">
          {message}
        </p>
        {lastChecked && canCheck && (
          <p className="muted">Last checked {lastChecked}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {(available || canCheck || (reloadNeeded && !available)) && (
          <div className="settings-card-actions">
            {canCheck && (
              // aria-disabled keeps keyboard focus on the button during a check.
              <button
                className="secondary"
                aria-disabled={checking || sending}
                onClick={() => {
                  if (!checking && !sending) void checkNow();
                }}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={checking ? "spin" : undefined}
                />
                {checking ? "Checking…" : "Check now"}
              </button>
            )}
            {available && (
              <button
                className="primary"
                disabled={sending || checking}
                onClick={() => void install(available)}
              >
                <ArrowDownToLine size={16} aria-hidden="true" />
                {sending ? "Scheduling…" : `Update to ${available.version}`}
              </button>
            )}
            {reloadNeeded && !available && (
              <button className="secondary" onClick={() => location.reload()}>
                Reload Workspace
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
