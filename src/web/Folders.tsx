import { useEffect, useRef, useState } from "react";
import { Folder, Upload, Unplug } from "lucide-react";
import { api } from "./api";

export function Folders({
  scope,
  id,
}: {
  scope: "chats" | "projects";
  id: string;
}) {
  const base = `/${scope}/${id}/folders`;
  const [links, setLinks] = useState<any[]>([]),
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
    void refresh().catch((e) => setError(e.message));
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
    if (!files?.length || !selected) return;
    await action(async () => {
      const list = Array.from(files);
      for (const [i, file] of list.entries()) {
        const relative = file.webkitRelativePath || file.name;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open(
            "POST",
            `/api/folders/${encodeURIComponent(selected)}/files?path=${encodeURIComponent(relative)}`,
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
      setBrowse(selected);
      setDirectory("");
      setFiles(await api(`/folders/${encodeURIComponent(selected)}/files`));
    });
    if (fileInput.current) fileInput.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
  }
  return (
    <section className="folder-settings" aria-label="Connected folders">
      <h3>Folders</h3>
      <p className="muted">
        {scope === "projects"
          ? "Connected folders are available to every chat in this project."
          : "Give this chat access to uploaded files or server folders."}{" "}
        Disconnecting keeps the files.
      </p>
      {links.map((link) => (
        <div className="folder-link" key={link.id}>
          <div>
            <strong>{link.name}</strong>
            <small>
              {link.read_only ? "Read only" : "Read & write"}
              {link.inherited ? " · From project" : ""}
            </small>
            <code>/workspace/.workspace-folders/{link.name}</code>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setBrowse(link.name);
              setDirectory("");
            }}
          >
            Browse
          </button>
          {!link.inherited && (
            <button
              type="button"
              className="icon-button"
              aria-label={`Disconnect folder ${link.name}`}
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
              <Unplug size={17} />
            </button>
          )}
        </div>
      ))}
      <label className="field">
        <span>Server folder</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a folder</option>
          {available.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <div className="folder-create">
        <input
          aria-label="New folder name"
          placeholder="New folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={80}
        />
        <button
          type="button"
          className="secondary"
          disabled={busy || !newName.trim()}
          onClick={() =>
            void action(async () => {
              await api("/folders", { name: newName.trim() });
              setSelected(newName.trim());
              setNewName("");
            })
          }
        >
          Create folder
        </button>
      </div>
      <label className="field">
        <span>Agent access</span>
        <select
          value={readOnly ? "ro" : "rw"}
          onChange={(e) => setReadOnly(e.target.value === "ro")}
        >
          <option value="ro">Read only</option>
          <option value="rw">Read & write</option>
        </select>
      </label>
      {!readOnly && (
        <p className="muted">
          Agents can change or delete files in this folder. Chats sharing it
          take turns while a writer is active.
        </p>
      )}
      <div className="folder-actions">
        <button
          type="button"
          className="primary"
          disabled={busy || !selected}
          onClick={() =>
            void action(async () => {
              await api(base, { name: selected, read_only: readOnly });
            })
          }
        >
          <Folder size={16} />
          Connect folder
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !selected}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} />
          Upload files
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !selected}
          onClick={() => folderInput.current?.click()}
        >
          Upload folder
        </button>
      </div>
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
      <p className="muted">
        Uploads keep their folder structure. Existing files are never
        overwritten; identical uploads can be retried. Folder selection depends
        on your browser. Archives stay compressed.
      </p>
      {progress && <p role="status">{progress}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {browse && (
        <div className="folder-browser">
          <strong>
            {browse}
            {directory ? "/" + directory : ""}
          </strong>
          <button
            type="button"
            className="text-button"
            onClick={() => setBrowse("")}
          >
            Close browser
          </button>
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
                {f.name}
              </button>
            ) : (
              <a
                className="file-row"
                key={f.path}
                href={`/api/folders/${encodeURIComponent(browse)}/file?path=${encodeURIComponent(f.path)}`}
                download
              >
                {f.name}
              </a>
            ),
          )}
        </div>
      )}
    </section>
  );
}
