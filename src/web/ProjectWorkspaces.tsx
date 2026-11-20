import { FolderActions, CreateWorkingCopy } from "./FolderActions";
import { useState } from "react";
import { FolderGit2, MessageSquarePlus } from "lucide-react";
import { Select } from "./Select";
import { api } from "./api";
import { workspaceLabel } from "./WorkspaceFiles";

export function ProjectWorkspaces({
  project,
  embedded = false,
  workspaces,
  onUpdated,
  onFiles,
  onNew,
  onOpenChat,
}: any) {
  const folders = workspaces.filter((w: any) => w.project_id === project.id);
  const main = folders.find((w: any) => w.kind === "main");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section
      className={
        "project-workspaces" +
        (embedded ? " settings-section-body working-folder-list" : "")
      }
      aria-label="Working folders"
    >
      {!embedded && <h3>Working folders</h3>}
      {embedded && (
        <p className="settings-section-intro">
          Share the main folder or work separately in a copy.
        </p>
      )}
      {!embedded && main && (
        <CreateWorkingCopy main={main} onUpdated={onUpdated} />
      )}
      {!main && (
        <div className="workspace-setup">
          <p>
            <strong>Choose your main folder</strong>
          </p>
          <p className="muted">
            Existing chat folders have been preserved separately. Choose one for
            shared work, or start from the repository. Other folders and chats
            stay where they are.
          </p>
          <label className="field">
            <span>Main folder source</span>
            <Select
              aria-label="Main folder source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={busy}
            >
              <option value="">Choose a source…</option>
              <option value="repository">Start from the repository</option>
              {folders.map((w: any) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
          <button
            className="primary"
            disabled={busy || !source}
            onClick={async () => {
              if (busy || !source) return;
              setBusy(true);
              setError("");
              try {
                await api(`/projects/${project.id}/main-workspace`, {
                  workspace_id: source === "repository" ? null : source,
                });
                await onUpdated();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Set main folder"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {folders.map((w: any) => {
        const syncBranch =
          project.repo &&
          w.initialized &&
          w.status === "ready" &&
          !w.resolution_operation_id
            ? project.base_branch
            : undefined;
        return (
          <div className="working-folder-card" key={w.id}>
            <div className="workspace-folder-row">
              <FolderGit2 size={18} />
              <span>
                <strong>
                  {w.name}{" "}
                  <span className={"folder-kind kind-" + w.kind}>
                    {w.kind === "main"
                      ? "Shared"
                      : w.kind === "copy"
                        ? w.resolution_source_id
                          ? "Resolution"
                          : "Copy"
                        : "Saved"}
                  </span>
                </strong>
                <small>
                  {w.kind === "main"
                    ? "Shared files · one task at a time"
                    : w.kind === "copy"
                      ? "Independent copy · review before transfer"
                      : "Saved files · separate from main"}
                </small>
                {w.last_applied_at && (
                  <small>
                    Last transferred{" "}
                    {new Date(w.last_applied_at).toLocaleString()}
                  </small>
                )}
                {w.status !== "ready" && (
                  <small>
                    Folder status: {w.status}.{" "}
                    {w.status === "failed"
                      ? "Creation did not finish. Remove this copy and try again."
                      : "Wait for the folder operation to finish."}
                  </small>
                )}
                {!!w.copy_exclusions?.length && (
                  <details>
                    <summary>Excluded from the starting copy</summary>
                    <pre>{w.copy_exclusions.join("\n")}</pre>
                  </details>
                )}
              </span>
              <button
                className={embedded ? "text-button" : "secondary"}
                onClick={() => onFiles(w)}
              >
                Files
              </button>
              <button
                className={embedded ? "icon-button" : "secondary"}
                aria-label={"New chat in " + workspaceLabel(w)}
                title="New chat in this folder"
                disabled={w.status !== "ready"}
                onClick={() => onNew(project.id, w.id)}
              >
                <MessageSquarePlus size={16} />
                {!embedded && " New chat"}
              </button>
            </div>
            {(w.kind !== "main" || syncBranch) && (
              <FolderActions
                workspace={w}
                syncBranch={syncBranch}
                compact={embedded}
                onUpdated={onUpdated}
                onOpenChat={onOpenChat}
              />
            )}
          </div>
        );
      })}
      {embedded && main && (
        <CreateWorkingCopy compact main={main} onUpdated={onUpdated} />
      )}
    </section>
  );
}
