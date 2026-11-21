import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectEnvironmentInfo } from "../shared";
import { api } from "./api";
import { ProjectSystemPackages } from "./ProjectSystemPackages";
import { Metric, resourceBytes } from "./ResourceMetric";

export function ProjectEnvironment({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="settings-disclosure"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Environment</summary>
      {open && <EnvironmentDetails projectId={projectId} />}
      <ProjectSystemPackages projectId={projectId} open={open} />
    </details>
  );
}

function EnvironmentDetails({ projectId }: { projectId: string }) {
  const url = "/projects/" + projectId + "/environment";
  const [info, setInfo] = useState<ProjectEnvironmentInfo>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const cancelButton = useRef<HTMLButtonElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  useLayoutEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (restoreFocus.current) {
      restoreFocus.current = false;
      const target = clearButton.current?.disabled
        ? refreshButton.current
        : clearButton.current;
      target?.focus();
    }
  }, [confirming]);

  useEffect(() => {
    let live = true;
    api<ProjectEnvironmentInfo>(url + (refresh ? "?refresh=1" : ""))
      .then((value) => {
        if (live) setInfo(value);
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [url, refresh]);

  async function clear() {
    setClearing(true);
    setError("");
    setNotice("");
    try {
      setInfo(
        await api<ProjectEnvironmentInfo>(url + "/clear", undefined, "POST"),
      );
      setNotice("Project tools cleared.");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setConfirming(false);
      setClearing(false);
    }
  }

  return (
    <div className="settings-section-body integration-settings">
      <p className="settings-section-intro">
        Chats and terminals share the tools installed in <code>/env</code>.
      </p>
      {info && (
        <Metric
          label="Project tools"
          value={
            info.usedBytes === null
              ? "Usage unavailable"
              : `${resourceBytes(info.usedBytes)} used`
          }
          detail={`Project limit is ${info.limitGib} GiB`}
          percent={
            info.usedBytes === null
              ? null
              : Math.min(100, (info.usedBytes / info.limitBytes) * 100)
          }
        />
      )}
      {info?.state === "over-budget" && (
        <p className="inline-error" role="status">
          Over the limit. <code>/env</code> is read-only in new sessions.
        </p>
      )}
      {info?.busy && (
        <p className="settings-section-note">
          Stop active tasks and close open terminals in this project before
          clearing tools.
        </p>
      )}
      {loading && !info && (
        <p className="muted" role="status">
          Loading usage…
        </p>
      )}
      {confirming && (
        <p className="settings-section-note">
          Remove all installed tools and caches from this project?
        </p>
      )}
      <div className="settings-card-actions integration-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="text-button"
              ref={cancelButton}
              disabled={clearing}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="secondary quiet-danger"
              disabled={clearing}
              onClick={() => void clear()}
            >
              {clearing ? "Clearing…" : "Confirm clearing"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              ref={refreshButton}
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setError("");
                setNotice("");
                setRefresh((value) => value + 1);
              }}
            >
              Refresh usage
            </button>
            <button
              type="button"
              className="secondary quiet-danger"
              ref={clearButton}
              disabled={loading || !info || info.busy || info.usedBytes === 0}
              onClick={() => {
                restoreFocus.current = true;
                setError("");
                setNotice("");
                setConfirming(true);
              }}
            >
              Clear tools
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
