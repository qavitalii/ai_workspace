import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
  Upload,
  WrapText,
  X,
} from "lucide-react";
import { api } from "./api";
import { prepareFilePreview } from "./file-preview";

export function workspaceLabel(w: {
  kind?: string;
  name?: string;
  workspace_kind?: string;
  workspace_name?: string;
}) {
  const kind = w.kind || w.workspace_kind;
  return kind === "main"
    ? "Main folder"
    : kind === "copy"
      ? "Copy · " + (w.name || w.workspace_name)
      : kind === "saved"
        ? "Saved folder · " + (w.name || w.workspace_name)
        : w.name || w.workspace_name || "Personal folder";
}

type FileEntry = { name: string; path: string; directory: boolean };
type Preview =
  | ReturnType<typeof prepareFilePreview>
  | { kind: "loading" | "large" }
  | { kind: "error"; message: string };

export function WorkspaceFiles({
  workspace,
  onUpdated,
}: {
  workspace: any;
  onUpdated: () => Promise<void>;
}) {
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [target, setTarget] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [wrap, setWrap] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewBack = useRef<HTMLButtonElement>(null);
  const listing = useRef<HTMLDivElement>(null);
  const base = `/workspaces/${workspace.id}`;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    Promise.all([
      api(base + "/files?path=" + encodeURIComponent(dir)),
      api(base + "/attachments"),
    ])
      .then(([files, attachments]) => {
        if (live) {
          setFiles(files);
          setAttachments(attachments);
        }
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
  }, [base, dir, version]);
  useEffect(() => {
    if (!previewPath) return;
    const controller = new AbortController();
    setPreview({ kind: "loading" });
    previewBack.current?.focus();
    fetch("/api" + base + "/file?path=" + encodeURIComponent(previewPath), {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            "Unable to open this file. Try refreshing or download it instead.",
          );
        const blob = await r.blob();
        const content: Preview =
          blob.size < 200000
            ? prepareFilePreview(await blob.text())
            : { kind: "large" };
        if (!controller.signal.aborted) setPreview(content);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setPreview({ kind: "error", message: e.message });
      });
    return () => controller.abort();
  }, [base, previewPath, version]);
  function navigate(path: string) {
    setDir(path);
    setPreviewPath(null);
    setQuery("");
    setNotice("");
    setUploadOpen(false);
    setSelected(null);
    setTarget("");
    listing.current?.scrollTo({ top: 0 });
  }
  function closePreview() {
    const path = previewPath;
    setPreviewPath(null);
    requestAnimationFrame(() => {
      const button = Array.from(
        listing.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-file-path]",
        ) || [],
      ).find((b) => b.dataset.filePath === path);
      button?.focus();
    });
  }
  async function action(fn: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      setVersion((v) => v + 1);
      await onUpdated();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const visible = files
    .filter((f) =>
      f.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  const parts = dir ? dir.split("/") : [];
  const download =
    "/api" + base + "/file?path=" + encodeURIComponent(previewPath || "");
  return (
    <section className="workspace-files" aria-label="Workspace files">
      <div className="files-toolbar">
        <nav className="files-breadcrumbs" aria-label="Folder path">
          <button
            className="text-button"
            title="Root folder"
            aria-label="Root folder"
            aria-current={!dir ? "location" : undefined}
            disabled={busy}
            onClick={() => navigate("")}
          >
            <FolderOpen size={15} />
            <span>Root</span>
          </button>
          {parts.map((part, i) => (
            <span className="files-crumb" key={i}>
              <ChevronRight size={12} />
              <button
                className="text-button"
                title={part}
                aria-current={i === parts.length - 1 ? "location" : undefined}
                disabled={busy}
                onClick={() => navigate(parts.slice(0, i + 1).join("/"))}
              >
                {part}
              </button>
            </span>
          ))}
        </nav>
        <div className="files-tools">
          <button
            className="icon-button"
            title="Add file"
            aria-label="Add file"
            aria-expanded={uploadOpen}
            disabled={busy}
            onClick={() => setUploadOpen(!uploadOpen)}
          >
            <Upload size={15} />
          </button>
          <button
            className="icon-button"
            title="Refresh files"
            aria-label="Refresh files"
            disabled={loading || busy}
            onClick={() => setVersion((v) => v + 1)}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      <div className="files-notices">
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
        {!workspace.initialized && (
          <div className="files-setup">
            <span>
              Prepare this folder to start working. Existing files are kept.
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(
                  () => api(base + "/initialize", {}),
                  "Folder ready.",
                )
              }
            >
              {busy ? "Preparing…" : "Prepare folder"}
            </button>
          </div>
        )}
      </div>
      {uploadOpen && (
        <form
          className="files-upload"
          onSubmit={(e) => {
            e.preventDefault();
            if (!selected) return;
            void action(
              async () => {
                const body = new FormData();
                body.append("file", selected);
                const r = await fetch(
                  "/api" + base + "/files?path=" + encodeURIComponent(target),
                  { method: "POST", body },
                );
                const result = await r.json();
                if (!r.ok) throw new Error(result.error || "Upload failed");
                setSelected(null);
                setTarget("");
                setUploadOpen(false);
              },
              "File saved in " + workspaceLabel(workspace) + ".",
            );
          }}
        >
          <div className="files-section-heading">
            <strong>Add a file</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel upload"
              disabled={busy}
              onClick={() => {
                setUploadOpen(false);
                setSelected(null);
                setTarget("");
              }}
            >
              <X size={15} />
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setSelected(file);
                setTarget((dir ? dir + "/" : "") + file.name);
              }
              e.target.value = "";
            }}
          />
          <div className="files-upload-choice">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              Choose file
            </button>
            <span title={selected?.name}>
              {selected?.name || "No file selected"}
            </span>
          </div>
          {selected && (
            <>
              <label className="field">
                <span>Save as (path from root)</span>
                <input
                  required
                  value={target}
                  disabled={busy}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </label>
              <div className="files-upload-actions">
                <small>Existing files won’t be overwritten.</small>
                <button className="primary" disabled={busy || !target.trim()}>
                  <Upload size={14} />
                  {busy ? "Saving…" : "Save file"}
                </button>
              </div>
            </>
          )}
        </form>
      )}
      {previewPath ? (
        <div className="files-document">
          <div className="files-document-heading">
            <button
              ref={previewBack}
              className="icon-button"
              aria-label="Back to files"
              title="Back to files"
              onClick={closePreview}
            >
              <ArrowLeft size={16} />
            </button>
            <strong title={previewPath}>{previewPath.split("/").at(-1)}</strong>
            {preview.kind === "text" && (
              <button
                className="icon-button"
                title="Wrap lines"
                aria-label="Wrap lines"
                aria-pressed={wrap}
                onClick={() => setWrap(!wrap)}
              >
                <WrapText size={16} />
              </button>
            )}
            <a
              className="icon-button"
              href={download}
              download
              title="Download file"
              aria-label="Download file"
            >
              <Download size={16} />
            </a>
          </div>
          {preview.kind === "loading" ? (
            <p className="files-empty" role="status">
              Loading preview…
            </p>
          ) : preview.kind === "text" ? (
            <>
              <div
                className={"files-code " + (wrap ? "wrap-lines" : "")}
                tabIndex={0}
                role="region"
                aria-label={`Preview of ${previewPath}`}
              >
                <div>
                  {preview.lines.map((line, i) => (
                    <div className="files-code-line" key={i}>
                      <span aria-hidden="true">{i + 1}</span>
                      <code>{line || " "}</code>
                    </div>
                  ))}
                </div>
              </div>
              {preview.truncated && (
                <p className="files-preview-note">
                  Showing the first 2,000 lines. Download for the full file.
                </p>
              )}
            </>
          ) : (
            <div className="files-empty">
              <FileText size={24} />
              <strong>
                {preview.kind === "error"
                  ? "Preview unavailable"
                  : preview.kind === "large"
                    ? "File too large to preview"
                    : "Download to view this file"}
              </strong>
              <p role={preview.kind === "error" ? "alert" : undefined}>
                {preview.kind === "error"
                  ? preview.message
                  : preview.kind === "large"
                    ? "Files under 200 KB can be previewed here."
                    : "This file format can’t be displayed as text."}
              </p>
              <a className="secondary" href={download} download>
                <Download size={14} />
                Download file
              </a>
            </div>
          )}
        </div>
      ) : (
        <>
          <label className="files-filter">
            <Search size={14} />
            <input
              aria-label="Filter files in this folder"
              placeholder="Filter this folder…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="Clear file filter"
                onClick={() => setQuery("")}
              >
                <X size={14} />
              </button>
            )}
          </label>
          <div ref={listing} className="files-list-scroll" aria-busy={loading}>
            {loading ? (
              <p className="files-empty" role="status">
                Loading files…
              </p>
            ) : (
              !error && (
                <>
                  {visible.length ? (
                    <div
                      className="files-list"
                      aria-label="Files in current folder"
                    >
                      {visible.map((f) => (
                        <button
                          key={f.path}
                          data-file-path={f.path}
                          className="files-entry"
                          disabled={busy}
                          onClick={() => {
                            if (f.directory) navigate(f.path);
                            else {
                              setPreview({ kind: "loading" });
                              setPreviewPath(f.path);
                            }
                          }}
                        >
                          {f.directory ? (
                            <Folder size={16} className="files-folder-icon" />
                          ) : (
                            <FileText size={16} />
                          )}
                          <span title={f.name}>{f.name}</span>
                          <small>
                            {f.directory
                              ? "Folder"
                              : f.name.includes(".")
                                ? f.name.split(".").at(-1)?.toUpperCase()
                                : "File"}
                          </small>
                          <ChevronRight size={14} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="files-empty">
                      <FolderOpen size={24} />
                      <strong>
                        {query ? "No matching files" : "This folder is empty"}
                      </strong>
                      <p>
                        {query
                          ? "Try a different name or clear the filter."
                          : "Add a file or let your agent create one."}
                      </p>
                    </div>
                  )}
                  {!!attachments.length && (
                    <details className="files-attachments">
                      <summary>
                        Chat attachments <span>{attachments.length}</span>
                      </summary>
                      <p>
                        Originals are kept separately. Save a copy to work with
                        it here.
                      </p>
                      {attachments.map((a) => (
                        <div className="files-attachment" key={a.id}>
                          <FileText size={15} />
                          <div>
                            <a href={"/api/attachments/" + a.id} title={a.name}>
                              {a.name}
                            </a>
                            <small>{a.chat_title || "Deleted chat"}</small>
                          </div>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() =>
                              void action(
                                () =>
                                  api(base + "/attachments/" + a.id + "/save", {
                                    path: (dir ? dir + "/" : "") + a.name,
                                  }),
                                "Attachment copied to this folder.",
                              )
                            }
                          >
                            Save copy here
                          </button>
                        </div>
                      ))}
                    </details>
                  )}
                </>
              )
            )}
          </div>
          <div className="files-footer">
            <span>
              {loading
                ? "Loading…"
                : error
                  ? "Unable to load files"
                  : query
                    ? `${visible.length} of ${files.length} items`
                    : `${files.length} ${files.length === 1 ? "item" : "items"}`}
            </span>
            <span title="Files are shared by chats in this folder and kept when a chat is deleted.">
              Shared by chats in this folder
            </span>
          </div>
        </>
      )}
    </section>
  );
}
