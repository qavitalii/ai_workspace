import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import {
  Folder,
  FolderPlus,
  FileText,
  Plus,
  Upload,
  Unplug,
  X,
} from "lucide-react";
import { api } from "./api";

export function Folders({
  scope,
  id,
  readOnlyOnly = false,
}: {
  scope: "chats" | "projects";
  id: string;
  readOnlyOnly?: boolean;
}) {
  const base = `/${scope}/${id}/folders`;
  const [links, setLinks] = useState<any[]>([]),
    [adding, setAdding] = useState(false),
    [creating, setCreating] = useState(false),
    [loading, setLoading] = useState(true),
    [available, setAvailable] = useState<string[]>([]),
    [selected, setSelected] = useState(""),
    [readOnly, setReadOnly] = useState(true),
    [newName, setNewName] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [browse, setBrowse] = useState(""),
    [directory, setDirectory] = useState(""),
    [files, setFiles] = useState<any[]>([]);
  const fileInput = useRef<HTMLInputElement>(null),
    folderInput = useRef<HTMLInputElement>(null);
  async function refresh() {
    const [l, a] = await Promise.all([api(base), api("/folders")]);
    setLinks(l);
    setAvailable(a.folders);
  }
  useEffect(() => {
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [base]);
  useEffect(() => {
    if (browse)
      void api(
        `/folders/${encodeURIComponent(browse)}/files?path=${encodeURIComponent(directory)}`,
      )
        .then(setFiles)
        .catch((e) => setError(e.message));
  }, [browse, directory]);
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length || !browse) return;
    await action(async () => {
      const list = Array.from(files);
      for (const [i, file] of list.entries()) {
        const relative = file.webkitRelativePath || file.name;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(
            "POST",
            `/api/folders/${encodeURIComponent(browse)}/files?path=${encodeURIComponent(relative)}`,
          );
          xhr.upload.onprogress = (e) =>
            setProgress(
              `${i + 1}/${list.length} · ${file.name} · ${e.lengthComputable ? Math.round((e.loaded / e.total) * 100) : 0}%`,
            );
          xhr.onload = () => {
            let data: any;
            try {
              data = JSON.parse(xhr.responseText);
            } catch {
              reject(new Error("Upload failed"));
              return;
            }
            xhr.status < 300
              ? resolve()
              : reject(new Error(data.error || "Upload failed"));
          };
          xhr.onerror = () =>
            reject(
              new Error(
                "Upload interrupted. Select the same files to retry; identical files are preserved.",
              ),
            );
          const form = new FormData();
          form.append("file", file);
          xhr.send(form);
        });
      }
      setProgress(
        `${list.length} file${list.length === 1 ? "" : "s"} uploaded.`,
      );
      setDirectory("");
      setFiles(await api(`/folders/${encodeURIComponent(browse)}/files`));
    });
    if (fileInput.current) fileInput.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
  }
  return (
    <section
      className="folder-settings connected-folders"
      aria-label="Connected folders"
    >
      <p className="connected-folder-intro">
        {scope === "projects"
          ? "Share reference files with every chat in this project."
          : "Give this chat access to shared reference files."}
      </p>
      {loading ? (
        <p className="muted" role="status">
          Loading folders…
        </p>
      ) : (
        <>
          {!links.length && !adding && (
            <div className="connected-folder-empty">
              <Folder size={20} aria-hidden="true" />
              <div>
                <strong>No folders connected</strong>
                <span>
                  Connect a server folder to make its files available.
                </span>
              </div>
            </div>
          )}
          <div className="connected-folder-list">
            {links.map((link) => (
              <div className="connected-folder-row" key={link.id}>
                <Folder size={18} aria-hidden="true" />
                <div className="connected-folder-info">
                  <strong title={link.name}>{link.name}</strong>
                  <small>
                    {link.read_only ? "Read only" : "Read & write"}
                    {link.inherited ? " · From project" : ""}
                  </small>
                </div>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setBrowse(link.name);
                    setDirectory("");
                    setProgress("");
                  }}
                >
                  Files
                </button>
                {!link.inherited && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Disconnect folder ${link.name}`}
                    title="Disconnect folder · files are kept"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await api(
                          base + "/" + encodeURIComponent(link.name),
                          undefined,
                          "DELETE",
                        );
                      })
                    }
                  >
                    <Unplug size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
          {!adding && (
            <button
              type="button"
              className="text-button connected-folder-add"
              onClick={() => setAdding(true)}
            >
              <Plus size={16} />
              Connect a folder
            </button>
          )}
        </>
      )}
      {adding && (
        <div className="connected-folder-editor">
          <div className="connected-folder-editor-heading">
            <strong>Connect a folder</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel connecting folder"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setCreating(false);
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div className="connected-folder-fields">
            <label className="field">
              <span>Server folder</span>
              <Select
                aria-label="Server folder"
                value={selected}
                disabled={busy}
                onChange={(e) => setSelected(e.target.value)}
              >
                <option value="">Choose a folder</option>
                {available.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span>Access</span>
              <Select
                aria-label="Agent access"
                disabled={readOnlyOnly || busy}
                value={readOnlyOnly || readOnly ? "ro" : "rw"}
                onChange={(e) => setReadOnly(e.target.value === "ro")}
              >
                <option value="ro">Read only</option>
                <option value="rw">Read & write</option>
              </Select>
            </label>
          </div>
          {!creating ? (
            <button
              type="button"
              className="text-button"
              onClick={() => setCreating(true)}
            >
              <FolderPlus size={15} />
              Create a new server folder
            </button>
          ) : (
            <div className="connected-folder-create">
              <label className="field">
                <span>New folder name</span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  maxLength={80}
                  disabled={busy}
                  placeholder="e.g. Brand assets"
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={busy || !newName.trim()}
                onClick={() =>
                  void action(async () => {
                    await api("/folders", { name: newName.trim() });
                    setSelected(newName.trim());
                    setNewName("");
                    setCreating(false);
                  })
                }
              >
                Create
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel creating folder"
                disabled={busy}
                onClick={() => setCreating(false)}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {readOnlyOnly && (
            <p className="muted">
              Working copies can only read connected folders.
            </p>
          )}
          {!readOnlyOnly && !readOnly && (
            <p className="muted">
              The agent can change or delete files in this folder. Chats sharing
              it take turns while a writer is active.
            </p>
          )}
          <div className="connected-folder-editor-footer">
            <button
              type="button"
              className="primary"
              disabled={busy || !selected}
              onClick={() =>
                void action(async () => {
                  await api(base, {
                    name: selected,
                    read_only: readOnlyOnly || readOnly,
                  });
                  setAdding(false);
                  setCreating(false);
                })
              }
            >
              {busy ? "Connecting…" : "Connect folder"}
            </button>
          </div>
        </div>
      )}
      {!!links.length && (
        <p className="connected-folder-note">
          Disconnecting a folder keeps its files.
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {browse && (
        <div className="connected-folder-browser">
          <header>
            <div>
              <strong>{browse}</strong>
              {directory && <small>{directory}</small>}
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="Close folder files"
              disabled={busy}
              onClick={() => setBrowse("")}
            >
              <X size={16} />
            </button>
          </header>
          <div className="connected-folder-file-list">
            {directory && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setDirectory(directory.split("/").slice(0, -1).join("/"))
                }
              >
                ← Parent folder
              </button>
            )}
            {!files.length && <p className="muted">This folder is empty.</p>}
            {files.map((f) =>
              f.directory ? (
                <button
                  type="button"
                  className="file-row"
                  key={f.path}
                  onClick={() => setDirectory(f.path)}
                >
                  <Folder size={15} />
                  <span>{f.name}</span>
                </button>
              ) : (
                <a
                  className="file-row"
                  key={f.path}
                  href={`/api/folders/${encodeURIComponent(browse)}/file?path=${encodeURIComponent(f.path)}`}
                  download
                >
                  <FileText size={15} />
                  <span>{f.name}</span>
                </a>
              ),
            )}
          </div>
          <div className="connected-folder-uploads">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={15} />
              Upload files
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => folderInput.current?.click()}
            >
              Upload folder
            </button>
          </div>
          <p className="connected-folder-note">
            Uploads go to {browse}. Existing files are kept; archives stay
            compressed.
          </p>
          {progress && (
            <p role="status" className="connected-folder-note">
              {progress}
            </p>
          )}
        </div>
      )}
      <input
        hidden
        type="file"
        multiple
        ref={fileInput}
        onChange={(e) => void upload(e.target.files)}
      />
      <input
        hidden
        type="file"
        multiple
        ref={folderInput}
        {...({ webkitdirectory: "" } as any)}
        onChange={(e) => void upload(e.target.files)}
      />
    </section>
  );
}
