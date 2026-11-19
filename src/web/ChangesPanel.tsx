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
  const [review, setReview] = useState<{
    diff: string;
    pushDiff: string;
    commits: string;
    pushError: string;
    review_token: string;
  } | null>(null);
  const [view, setView] = useState<"commit" | "push">("commit");
  const [reviewTarget, setReviewTarget] = useState<"commit" | "push" | null>(
    null,
  );
  const [local, setLocal] = useState<{
    diff: string;
    untracked: string[];
  } | null>(null);
  const diff =
    (view === "commit"
      ? (review?.diff ?? local?.diff)
      : reviewTarget === "push"
        ? review?.pushDiff
        : "") || "";
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [revision, setRevision] = useState(0);
  const [raw, setRaw] = useState(false);
  const files = useMemo(() => parseDiff(diff), [diff]);
  const fileCount = new Set(files.map((file) => file.path)).size;
  const added = files.reduce((total, f) => total + f.added, 0);
  const removed = files.reduce((total, f) => total + f.removed, 0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setReview(null);
    setReviewTarget(null);
    setLocal(null);
    setError("");
    api(`/chats/${chatId}/diff`)
      .then((r) => {
        if (live) setLocal(r);
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
  async function prepareReview() {
    setLoading(true);
    setError("");
    setReview(null);
    setReviewTarget(null);
    try {
      const prepared = await api(`/chats/${chatId}/publication-review`, {
        target: view,
      });
      setReview(prepared);
      setReviewTarget(view);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function publish(action: string) {
    if (
      publishing ||
      loading ||
      (action !== "push" && !message.trim()) ||
      !review ||
      (action !== "commit" && reviewTarget !== "push")
    )
      return;
    setPublishing(true);
    setResult("");
    setError("");
    try {
      const r = await api(`/chats/${chatId}/git`, {
        action,
        message,
        client_id: crypto.randomUUID(),
        review_token: review.review_token,
      });
      setResult(r.html_url || r.output || r.status || "Done");
      setReview(null);
      setReviewTarget(null);
      setRevision((value) => value + 1);
      if (action === "commit") setView("push");
    } catch (e: any) {
      setError(e.message);
      setReview(null);
    } finally {
      setPublishing(false);
    }
  }
  const disabled = publishing || loading || !review;
  return (
    <section className="changes-panel" aria-label="Code changes">
      <div className="changes-tools">
        <button
          aria-pressed={view === "commit"}
          disabled={loading || publishing}
          onClick={() => setView("commit")}
        >
          Next commit
        </button>
        <button
          disabled={loading || publishing}
          aria-pressed={view === "push"}
          onClick={() => setView("push")}
        >
          Outgoing commits
        </button>
      </div>
      <p className="settings-section-note">
        {review && (view === "commit" || reviewTarget === "push")
          ? "Review the prepared changes below before publishing. Later edits require a new review."
          : view === "commit"
            ? "Live local preview. Files may change while a task runs. Prepare a review to inspect the complete next commit, including new files."
            : "Prepare a review to compare outgoing commits with GitHub."}
      </p>
      <button
        className="secondary"
        disabled={loading || publishing}
        onClick={() => void prepareReview()}
      >
        {loading
          ? "Loading…"
          : view === "commit"
            ? "Prepare commit review"
            : "Review outgoing commits"}
      </button>
      {view === "commit" && !review && !!local?.untracked.length && (
        <details open>
          <summary>New files ({local.untracked.length})</summary>
          <ul>
            {local.untracked.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </details>
      )}
      {view === "push" && review?.commits && <pre>{review.commits}</pre>}
      {view === "push" && review?.pushError && (
        <p role="alert">{review.pushError}</p>
      )}
      <div className="changes-toolbar">
        <div className="changes-count" aria-live="polite">
          <strong>
            {loading
              ? "Loading…"
              : `${fileCount} ${fileCount === 1 ? "file" : "files"} changed`}
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
        {!loading &&
          !error &&
          !diff &&
          (view === "commit"
            ? !local?.untracked.length || !!review
            : reviewTarget === "push") &&
          !(view === "push" && review?.pushError) && (
            <div className="changes-empty">
              <Check size={24} />
              <strong>
                {view === "commit"
                  ? "No changes to commit"
                  : "No outgoing file changes"}
              </strong>
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
            disabled={
              disabled || !message.trim() || view !== "commit" || !review?.diff
            }
            onClick={() => publish("commit")}
          >
            <GitCommitHorizontal size={15} />
            Commit
          </button>
          <button
            className="secondary"
            disabled={
              disabled ||
              view !== "push" ||
              reviewTarget !== "push" ||
              !!review?.pushError
            }
            onClick={() => publish("push")}
          >
            <Upload size={15} />
            Push
          </button>
          <button
            className="secondary"
            disabled={
              disabled ||
              !message.trim() ||
              view !== "push" ||
              reviewTarget !== "push" ||
              !!review?.pushError
            }
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
