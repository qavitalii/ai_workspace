import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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

function updateInProgress(status: UpdateStatus | null) {
  return status?.phase === "waiting" || status?.phase === "updating";
}

function browserReloadVersion(status: UpdateStatus | null) {
  return status?.phase === "succeeded" &&
    status.installed !== `v${clientVersion}`
    ? status.installed
    : null;
}

export function useWorkspaceUpdates(enabled: boolean, watching: boolean) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [action, setAction] = useState<"install" | "check" | null>(null);
  const [error, setError] = useState("");
  const checkingRef = useRef(false);
  const reload = useRef(() => {});
  const busy = updateInProgress(status);
  const fastPoll = watching || busy || action === "install";
  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setConnectionLost(false);
      setError("");
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
        if (updateInProgress(next) || browserReloadVersion(next)) setError("");
      } catch {
        if (!stopped && mine === sequence) setConnectionLost(true);
      } finally {
        if (!stopped && mine === sequence)
          timer = setTimeout(
            load,
            fastPoll ? 3500 : checkingRef.current ? 2000 : 60_000,
          );
      }
    }
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled, fastPoll]);

  async function requestUpdate(release?: Release) {
    if (action) return;
    setAction(release ? "install" : "check");
    setError("");
    try {
      if (release) {
        await api("/updates", release);
        setStatus((current) =>
          current &&
          current.phase !== "updating" &&
          current.installed !== release.version
            ? { ...current, phase: "waiting", target: release, message: null }
            : current,
        );
      } else {
        await api("/updates/check", {});
        checkingRef.current = true;
        setStatus((current) =>
          current ? { ...current, checking: true } : current,
        );
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      reload.current();
      setAction(null);
    }
  }

  const reloadVersion = connectionLost ? null : browserReloadVersion(status);
  const available =
    status?.updater === "ready" &&
    !status.checkFailed &&
    !busy &&
    !connectionLost &&
    !reloadVersion
      ? status.available
      : null;
  let shortcut = "";
  if (busy && connectionLost) shortcut = "Reconnecting…";
  else if (status?.phase === "waiting") shortcut = "Update scheduled";
  else if (status?.phase === "updating") shortcut = "Installing update…";
  else if (reloadVersion) shortcut = "Update installed";
  else if (action === "install") shortcut = "Scheduling update…";
  else if (!connectionLost && status?.phase === "failed")
    shortcut = "Update failed";
  else if (available) shortcut = "Update available";

  return {
    status,
    connectionLost,
    busy,
    action,
    error,
    available,
    reloadVersion,
    shortcut,
    requestUpdate,
  };
}

export const updateReturnKey = "returnToWorkspaceUpdates";

export function UpdateSettings({
  status,
  connectionLost,
  busy,
  action,
  error,
  available,
  reloadVersion,
  requestUpdate,
}: ReturnType<typeof useWorkspaceUpdates>) {
  const [reloading, setReloading] = useState(false);
  const statusNotice = useRef<HTMLDivElement>(null);
  const installHadFocus = useRef(false);
  useEffect(() => {
    if (available || !installHadFocus.current) return;
    installHadFocus.current = false;
    if (document.activeElement === document.body) statusNotice.current?.focus();
  }, [available]);
  const checking = action === "check" || !!status?.checking;
  const target = status?.target?.version ?? status?.available?.version;
  const canCheck =
    status?.updater === "ready" && !busy && !connectionLost && !reloadVersion;
  // Kept visible while checking so the dialog does not change height.
  const lastChecked = status?.checkedAt
    ? new Date(status.checkedAt).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  let title = "Checking for updates…";
  let message = "";
  if (reloading) {
    title = "Reloading Workspace…";
    message = "Updates will reopen after the page loads.";
  } else if (connectionLost) {
    title = "Reconnecting to Workspace…";
    message =
      "This page will reconnect automatically when the server is available.";
  } else if (status?.phase === "updating") {
    title = target ? `Installing Workspace ${target}…` : "Installing update…";
    message =
      "Preparing the release, backing up data, and restarting can take several minutes.";
  } else if (reloadVersion) {
    title = `Workspace ${reloadVersion} installed`;
    message = "Reload this page to start using the new version.";
  } else if (status?.updater === "offline" && status.phase !== "succeeded") {
    title = busy ? "Update scheduled" : "Update service unavailable";
    message =
      "Workspace is waiting for the server’s update service to come back online.";
  } else if (status?.phase === "waiting") {
    title = target ? `Update to ${target} scheduled` : "Update scheduled";
    message =
      "Installation starts automatically after active tasks and sign-ins finish, pending approvals are answered, and open terminals are closed. Queued tasks resume after the restart.";
  } else if (action === "install") {
    title = `Scheduling update to ${available?.version ?? target ?? "the new version"}…`;
  } else if (checking) {
    title = "Checking for updates…";
  } else if (status?.phase === "failed") {
    title = "";
    message = status.message ?? "The update could not be installed.";
  } else if (available) {
    title = `Workspace ${available.version} is available`;
    message =
      "Installation starts when Workspace is idle. Workspace backs up your data before restarting.";
  } else if (status?.updater === "disabled") {
    title = "Browser updates unavailable";
    message =
      "Browser updates are available on Linux servers with the update service enabled.";
  } else if (status?.checkFailed) {
    title = "Couldn’t check for updates";
    message = "Try again now or wait for the next automatic check.";
  } else if (status?.phase === "succeeded") {
    title = `Workspace ${status.installed} is ready to use`;
  } else if (status?.checkedAt) {
    title = "Workspace is up to date";
  }

  function reloadWorkspace() {
    if (reloading) return;
    history.replaceState({ ...history.state, [updateReturnKey]: true }, "");
    flushSync(() => setReloading(true));
    location.reload();
  }

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
        <div
          className="workspace-update-status"
          ref={statusNotice}
          role="status"
          tabIndex={-1}
        >
          {title && <strong>{title}</strong>}
          {message && <p className="muted">{message}</p>}
        </div>
        {lastChecked && canCheck && (
          <p className="muted">Last checked {lastChecked}</p>
        )}
        {error && !busy && !reloadVersion && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {(available || canCheck || reloadVersion) && (
          <div className="settings-card-actions workspace-update-actions">
            {canCheck && (
              // aria-disabled keeps keyboard focus on the button during a check.
              <button
                className="secondary"
                aria-disabled={checking || !!action}
                onClick={() => {
                  if (!checking) void requestUpdate();
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
                aria-disabled={!!action || checking}
                onFocus={() => (installHadFocus.current = true)}
                onBlur={() => (installHadFocus.current = false)}
                onClick={() => {
                  if (!checking) void requestUpdate(available);
                }}
              >
                <ArrowDownToLine size={16} aria-hidden="true" />
                {action === "install"
                  ? "Scheduling…"
                  : status?.phase === "failed" &&
                      status.target?.version === available.version
                    ? `Retry update to ${available.version}`
                    : `Install ${available.version}`}
              </button>
            )}
            {reloadVersion && (
              <button
                className="primary"
                aria-disabled={reloading}
                onClick={reloadWorkspace}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={reloading ? "spin" : undefined}
                />
                {reloading ? "Reloading…" : "Reload Workspace"}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
