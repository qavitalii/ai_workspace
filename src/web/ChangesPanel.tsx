import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  FileCode2,
  GitCommitHorizontal,
  GitPullRequest,
  RefreshCw,
  Upload,
} from "lucide-react";
import { api } from "./api";
import { parseDiff } from "./diff";

export function ChangesPanel({ chatId }: { chatId: string }) {
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [raw, setRaw] = useState(false);
  const files = useMemo(() => parseDiff(diff), [diff]);
  const added = files.reduce((total, f) => total + f.added, 0);
  const removed = files.reduce((total, f) => total + f.removed, 0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    api(`/chats/${chatId}/diff`)
      .then((r) => {
        if (live) setDiff(r.diff);
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chatId, revision]);
  async function publish(action: string) {
    if (publishing || loading || !message.trim()) return;
    setPublishing(true);
    setResult("");
    setError("");
    try {
      const r = await api(`/chats/${chatId}/git`, {
        action,
        message,
        client_id: crypto.randomUUID(),
      });
      setResult(r.html_url || r.output || r.status || "Done");
      const updated = await api(`/chats/${chatId}/diff`);
      setDiff(updated.diff);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPublishing(false);
    }
  }
  const disabled = !message.trim() || publishing || loading;
  return (
    <section className="changes-panel" aria-label="Code changes">
      <div className="changes-toolbar">
        <div className="changes-count" aria-live="polite">
          <strong>
            {loading
              ? "Loading…"
              : `${files.length} ${files.length === 1 ? "file" : "files"} changed`}
          </strong>
          {!!files.length && (
            <span
              className="change-stats"
              aria-label={`${added} added, ${removed} removed`}
            >
              <span>+{added}</span>
              <span>−{removed}</span>
            </span>
          )}
        </div>
        <div className="changes-tools">
          <button
            className="text-button"
            aria-pressed={raw}
            onClick={() => setRaw(!raw)}
          >
            {raw ? "Formatted" : "Raw diff"}
          </button>
          <button
            className="icon-button"
            aria-label="Refresh changes"
            title="Refresh changes"
            disabled={loading || publishing}
            onClick={() => setRevision((v) => v + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      <div className="changes-scroll" aria-busy={loading}>
        {error && (
          <p className="changes-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && !diff && (
          <div className="changes-empty">
            <Check size={24} />
            <strong>No tracked changes</strong>
            <p>
              Changes to tracked files will appear here. New files appear after
              a commit.
            </p>
          </div>
        )}
        {raw && diff ? (
          <pre className="changes-raw">{diff}</pre>
        ) : (
          files.map((file, index) => (
            <details className="change-file" key={`${index}:${file.path}`} open>
              <summary>
                <ChevronRight size={14} className="change-chevron" />
                <FileCode2 size={15} />
                <span className="change-file-path" title={file.path}>
                  {file.path}
                </span>
                <span className="change-stats">
                  <span>+{file.added}</span>
                  <span>−{file.removed}</span>
                </span>
              </summary>
              <div
                className="change-code"
                tabIndex={0}
                role="region"
                aria-label={`Changes in ${file.path}`}
              >
                <div className="change-lines">
                  {file.lines.map((line, i) => (
                    <div className={`change-line ${line.kind}`} key={i}>
                      <span className="change-number">{line.old}</span>
                      <span className="change-number">{line.next}</span>
                      <span className="change-sign">
                        {line.kind === "added"
                          ? "+"
                          : line.kind === "removed"
                            ? "−"
                            : ""}
                      </span>
                      <code>{line.text || " "}</code>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          ))
        )}
      </div>
      <div className="changes-publish">
        <label htmlFor="change-message">
          Commit message / pull request title
        </label>
        <input
          id="change-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Describe these changes"
        />
        <div className="changes-actions">
          <button
            className="primary"
            disabled={disabled}
            onClick={() => publish("commit")}
          >
            <GitCommitHorizontal size={15} />
            Commit
          </button>
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => publish("push")}
          >
            <Upload size={15} />
            Push
          </button>
          <button
            className="secondary"
            disabled={disabled}
            onClick={() => publish("pr")}
          >
            <GitPullRequest size={15} />
            Create PR
          </button>
        </div>
        {publishing && <p role="status">Publishing changes…</p>}
        {result && (
          <p className="operation-result" role="status">
            {result.startsWith("https://github.com/") ? (
              <a href={result} target="_blank" rel="noreferrer">
                Open pull request ↗
              </a>
            ) : (
              result
            )}
          </p>
        )}
      </div>
    </section>
  );
}
