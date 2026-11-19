import {
  ArrowRight,
  Sparkles,
  CheckCircle2,
  GitCompareArrows,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { Select } from "./Select";
import { api } from "./api";
export function RemovalConfirmation({
  name,
  description,
  busy,
  onConfirm,
  onCancel,
  requireName = true,
}: any) {
  const [typed, setTyped] = useState("");
  return (
    <div
      className="removal-confirmation"
      role="region"
      aria-label={"Confirm deletion of " + name}
    >
      <strong>Delete {name}?</strong>
      <p>{description}</p>
      {requireName && (
        <label className="field">
          <span>Type “{name}” to confirm</span>
          <input
            autoFocus
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
          />
        </label>
      )}
      <div className="folder-action-buttons">
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="danger-button"
          disabled={busy || (requireName && typed !== name)}
          onClick={onConfirm}
        >
          {busy
            ? "Deleting…"
            : requireName
              ? "Delete folder and chats"
              : "Delete account"}
        </button>
      </div>
    </div>
  );
}
export function FolderActions({
  workspace: w,
  onUpdated,
  onOpenChat,
  compact = false,
}: any) {
  const [review, setReview] = useState<any>(null),
    [accounts, setAccounts] = useState<any[]>([]),
    [accountId, setAccountId] = useState(""),
    [deletion, setDeletion] = useState<any>(null),
    [choices, setChoices] = useState<Record<string, "main" | "copy">>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const refresh = () =>
    run(async () => {
      setDeletion(null);
      setReview(await api(`/workspaces/${w.id}/review`, {}));
      setChoices({});
      const overview = await api("/overview");
      const available = overview.accounts.filter((a: any) =>
        ["ready", "limited"].includes(a.status),
      );
      setAccounts(available);
      setAccountId((current) =>
        available.some((a: any) => a.id === current)
          ? current
          : available[0]?.id || "",
      );
    });
  return (
    <div className="working-copy-actions">
      <div className="folder-action-buttons">
        {w.kind === "copy" && (
          <button
            className={compact ? "text-button" : "secondary"}
            disabled={busy || w.status !== "ready"}
            onClick={review ? () => setReview(null) : refresh}
          >
            <GitCompareArrows size={16} />
            {busy ? "Working…" : review ? "Hide review" : "Review changes"}
          </button>
        )}
        {w.kind !== "main" && (
          <button
            className="text-button quiet-danger"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setDeletion(await api(`/workspaces/${w.id}/deletion`));
                setReview(null);
              })
            }
          >
            <Trash2 size={15} /> Delete folder
          </button>
        )}
      </div>
      {notice && (
        <p className="folder-success" role="status">
          <CheckCircle2 size={18} />
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {deletion && (
        <RemovalConfirmation
          name={w.name}
          busy={busy}
          onCancel={() => setDeletion(null)}
          description={`This permanently deletes this folder, ${deletion.chats.length} linked chats and ${deletion.attachments} saved attachments. Any changes you have not transferred will be lost, including excluded files. Main and connected folders are preserved. ${deletion.chats.length ? "Chats: " + deletion.chats.map((c: any) => c.title).join(", ") + "." : ""}`}
          onConfirm={() =>
            run(async () => {
              const result = await api(
                `/workspaces/${w.id}`,
                { name: w.name },
                "DELETE",
              );
              setDeletion(null);
              if (result.cleanupPending)
                setNotice(
                  "Folder removed. Remaining file cleanup will retry when the server restarts.",
                );
              await onUpdated();
            })
          }
        />
      )}
      {review && (
        <section className="copy-review" aria-label={"Changes in " + w.name}>
          <header>
            <div>
              <span className="review-eyebrow">
                {w.name} <ArrowRight size={13} /> Main folder
              </span>
              <h4>Review changes</h4>
            </div>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Close review
            </button>
          </header>
          <p>
            Review the current main version and the proposed result. Files
            changed in both folders are combined where possible. An agent can
            resolve conflicts, or you can choose a version yourself.
          </p>
          <div className="change-counts" aria-label="Change summary">
            {["added", "modified", "deleted"].map((status) => {
              const n = review.changes.filter(
                (c: any) => c.status === status,
              ).length;
              return (
                n > 0 && (
                  <span className={"change-count " + status} key={status}>
                    {n} {status}
                  </span>
                )
              );
            })}
            {review.changes.some((c: any) => c.conflict) && (
              <span className="change-count conflict">
                {review.changes.filter((c: any) => c.conflict).length} to
                resolve
              </span>
            )}
          </div>
          {!review.changes.length && (
            <p className="folder-success">
              <CheckCircle2 size={18} /> No changes to transfer.
            </p>
          )}
          {review.resolutionMessage && (
            <p className="inline-error" role="status">
              {review.resolutionMessage}
            </p>
          )}
          {!w.resolution_source_id &&
            review.changes.some((c: any) => c.conflict) && (
              <div className="agent-resolution">
                <div className="agent-resolution-heading">
                  <Sparkles size={20} />
                  <strong>Combine both versions with an agent</strong>
                </div>
                <p>
                  The agent works in a separate folder, resolves conflicts and
                  checks the result. You review it before transferring to main.
                </p>
                {accounts.length ? (
                  <>
                    <label className="field">
                      <span>Agent account</span>
                      <Select
                        aria-label="Resolution agent account"
                        value={accountId}
                        disabled={busy}
                        onChange={(e) => setAccountId(e.target.value)}
                      >
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} ·{" "}
                            {a.provider === "codex" ? "Codex" : "Claude Code"}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <button
                      className="primary"
                      disabled={busy || !accountId}
                      onClick={() =>
                        run(async () => {
                          const result = await api(
                            `/workspaces/${w.id}/resolve`,
                            { review_id: review.id, account_id: accountId },
                          );
                          setReview(null);
                          setNotice(
                            "Resolution chat created. Review its folder when the agent finishes.",
                          );
                          await onUpdated();
                          onOpenChat?.(result.chat_id);
                        })
                      }
                    >
                      <Sparkles size={16} />
                      {busy ? "Preparing resolution…" : "Resolve with agent"}
                    </button>
                  </>
                ) : (
                  <p className="muted">
                    Connect an agent account to resolve these conflicts
                    automatically.
                  </p>
                )}
              </div>
            )}
          {review.changes.map((change: any) => (
            <details
              className={
                "copy-change" + (change.conflict ? " has-conflict" : "")
              }
              key={change.path}
              open={change.conflict || review.changes.length === 1}
            >
              <summary>
                {change.path}{" "}
                <span>
                  {change.status}
                  {change.conflict ? " · Choose a version" : ""}
                </span>
              </summary>
              {change.conflict && (
                <fieldset className="conflict-choices" disabled={busy}>
                  <legend>Which version should go into the main folder?</legend>
                  {[
                    { value: "main", label: "Keep main version" },
                    { value: "copy", label: "Use working copy" },
                  ].map((option) => (
                    <label
                      key={option.value}
                      className={
                        choices[change.path] === option.value ? "selected" : ""
                      }
                    >
                      <input
                        type="radio"
                        name={review.id + change.path}
                        value={option.value}
                        checked={choices[change.path] === option.value}
                        onChange={() =>
                          setChoices({
                            ...choices,
                            [change.path]: option.value as "main" | "copy",
                          })
                        }
                      />
                      {option.label}
                    </label>
                  ))}
                </fieldset>
              )}
              {change.children?.map((child: any) => (
                <details key={child.path} open>
                  <summary>
                    {child.path} · {child.status}
                  </summary>
                  <div className="copy-comparison">
                    <div>
                      <strong>Current main</strong>
                      <pre>
                        {child.main ??
                          "Binary or large file — preview unavailable"}
                      </pre>
                    </div>
                    <div>
                      <strong>Working copy</strong>
                      <pre>
                        {child.copy ??
                          "Binary or large file — preview unavailable"}
                      </pre>
                    </div>
                  </div>
                </details>
              ))}
              <div className="copy-comparison">
                <div>
                  <strong>Current main</strong>
                  <pre>
                    {change.main ??
                      "Binary or large file — preview unavailable"}
                  </pre>
                </div>
                <div>
                  <strong>
                    {change.conflict ? "Working copy" : "After transfer"}
                  </strong>
                  <pre>
                    {(change.conflict ? change.copy : change.result) ??
                      "Binary or large file — preview unavailable"}
                  </pre>
                </div>
              </div>
            </details>
          ))}
          {!!review.excluded.length && (
            <details>
              <summary>{review.excluded.length} excluded paths</summary>
              <p>
                Environment files, local credentials, dependencies and build
                output are not transferred.
              </p>
              <pre>{review.excluded.join("\n")}</pre>
            </details>
          )}
          <p className="muted">
            A recovery copy of the main folder is saved before transfer. Your
            working copy stays available. This does not publish to GitHub.
          </p>
          <div className="folder-action-buttons">
            <button className="secondary" disabled={busy} onClick={refresh}>
              Refresh review
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !review.changes.length ||
                !!review.resolutionMessage ||
                review.changes.some(
                  (c: any) =>
                    c.conflict &&
                    choices[c.path] !== "main" &&
                    choices[c.path] !== "copy",
                )
              }
              onClick={() =>
                run(async () => {
                  await api(`/workspaces/${w.id}/apply`, {
                    review_id: review.id,
                    choices,
                  });
                  setReview(null);
                  setNotice(
                    "Changes transferred. The previous main folder is saved for recovery.",
                  );
                  await onUpdated();
                })
              }
            >
              {busy ? (
                "Transferring…"
              ) : (
                <>
                  Transfer to main folder <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
export function CreateWorkingCopy({ main, onUpdated, compact = false }: any) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div
      className={
        "create-working-copy" + (compact ? " compact-copy-creator" : "")
      }
    >
      {(!compact || !open) && (
        <button
          type="button"
          className={compact ? "text-button" : "secondary"}
          disabled={busy || main.status !== "ready"}
          onClick={() => setOpen(!open)}
        >
          <Plus size={16} /> New working copy
        </button>
      )}
      {open && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await api(`/workspaces/${main.id}/copies`, { name: name.trim() });
              setOpen(false);
              setName("");
              await onUpdated();
            } catch (e: any) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {compact && (
            <header className="copy-creator-heading">
              <strong>New working copy</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel creating working copy"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
          )}
          <p>
            Start with the main folder’s current files, including uncommitted
            changes. Work separately, then review and transfer changes back.
          </p>
          <p className="muted">
            Dependencies, build output, local credential files and .env files
            are excluded. Connected folders are read-only. External services and
            databases are still shared.
          </p>
          <label className="field">
            <span>Copy name</span>
            <input
              autoFocus
              required
              maxLength={80}
              placeholder="For example: Update the homepage"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="copy-creator-footer">
            <button className="primary" disabled={busy || !name.trim()}>
              {busy ? "Creating copy…" : "Create working copy"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </div>
  );
}
