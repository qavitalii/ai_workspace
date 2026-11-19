import { useEffect, useState } from "react";
import { Server as ServerIcon, KeyRound, Trash2 } from "lucide-react";
import { api } from "./api";
import { Select } from "./Select";

type Server = {
  id: string;
  name: string;
  alias: string;
  host: string;
  port: number;
  username: string;
  key_id: string;
  host_keys: string[];
  last_checked_at?: string;
  last_check_ok?: boolean;
  last_check_message?: string;
};
type Key = {
  id: string;
  name: string;
  public_key: string;
  fingerprint: string;
};
const blankServer = {
  name: "",
  alias: "",
  host: "",
  port: 22,
  username: "",
  key_id: "",
};

export function SshSettings() {
  const [servers, setServers] = useState<Server[]>([]),
    [keys, setKeys] = useState<Key[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [name, setName] = useState(""),
    [operation, setOperation] = useState("generate");
  const [privateKey, setPrivateKey] = useState(""),
    [passphrase, setPassphrase] = useState("");
  const [form, setForm] = useState(blankServer),
    [editing, setEditing] = useState<string | null>(null);
  const [review, setReview] = useState<{
    id: string;
    token: string;
    keys: { key: string; fingerprint: string }[];
  } | null>(null);
  async function refresh() {
    const [s, k] = await Promise.all([
      api<Server[]>("/servers"),
      api<Key[]>("/ssh-keys"),
    ]);
    setServers(s);
    setKeys(k);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ssh-settings" aria-label="Servers and SSH keys">
      <header className="workspace-settings-heading">
        <h3>Servers &amp; SSH</h3>
        <p className="muted">
          Add a server, verify its fingerprint, then grant access in project or
          chat settings.
        </p>
      </header>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {busy && <p role="status">Working…</p>}
      <section
        className="workspace-settings-card ssh-group"
        aria-label="Saved SSH keys"
      >
        <header className="settings-card-heading">
          <h4>SSH keys</h4>
          <span>{keys.length}</span>
        </header>
        {!keys.length && (
          <p className="settings-section-note">
            No SSH keys yet. Create or import one below.
          </p>
        )}
        <div className="ssh-list">
          {keys.map((k) => (
            <article className="ssh-card" key={k.id}>
              <div className="ssh-item-heading">
                <KeyRound size={18} aria-hidden="true" />
                <div>
                  <strong>{k.name}</strong>
                  <code className="ssh-wrap">{k.fingerprint}</code>
                </div>{" "}
                <button
                  type="button"
                  className="icon-button quiet-danger"
                  aria-label={"Delete SSH key " + k.name}
                  title="Delete SSH key"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `Delete SSH key “${k.name}” from Workspace? Its public key remains on remote servers.`,
                      )
                    )
                      void act(async () => {
                        await api(`/ssh-keys/${k.id}`, undefined, "DELETE");
                      });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <details>
                <summary>Public key to install on your server</summary>
                <pre className="ssh-wrap">{k.public_key}</pre>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await navigator.clipboard.writeText(k.public_key);
                      setMessage("Public key copied.");
                    })
                  }
                >
                  Copy public key
                </button>
                <p className="muted">
                  Add this public key as a new line in the remote user's
                  ~/.ssh/authorized_keys. Keep existing lines.
                </p>
              </details>
            </article>
          ))}
        </div>
      </section>
      <details className="settings-disclosure" open={!keys.length}>
        <summary>Add SSH key</summary>
        <form
          className="ssh-key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/ssh-keys", {
                name,
                operation,
                ...(operation === "import"
                  ? { private_key: privateKey, passphrase }
                  : {}),
              });
              setName("");
              setPrivateKey("");
              setPassphrase("");
              setOperation("generate");
              setMessage("SSH key saved. Copy its public key to your server.");
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend className="visually-hidden">Add SSH key</legend>
            <label className="field">
              <span>Key name</span>
              <input
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="field">
              <span>Key source</span>
              <Select
                aria-label="Key source"
                disabled={busy}
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value);
                  setPrivateKey("");
                  setPassphrase("");
                }}
              >
                <option value="generate">Create an Ed25519 key</option>
                <option value="import">Import a private key</option>
              </Select>
            </div>
            {operation === "import" && (
              <>
                <label className="field">
                  <span>Private key file (optional)</span>
                  <input
                    type="file"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 65536) {
                        setError("SSH keys must be under 64 KB.");
                        return;
                      }
                      void file
                        .text()
                        .then(setPrivateKey)
                        .catch(() => setError("Could not read this file."));
                      e.target.value = "";
                    }}
                  />
                </label>
                <label className="field">
                  <span>Private key</span>
                  <textarea
                    required
                    value={privateKey}
                    maxLength={65536}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    rows={4}
                  />
                </label>
                <label className="field">
                  <span>Key passphrase (if protected)</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={1024}
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </label>
                <p className="muted">
                  OpenSSH Ed25519, RSA and ECDSA keys are supported. The
                  passphrase is used once; Workspace stores the key encrypted
                  for unattended connections.
                </p>
              </>
            )}
            <div className="settings-card-actions">
              <button className="primary">
                {operation === "generate" ? "Create key" : "Import key"}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
      <section
        className="workspace-settings-card ssh-group"
        aria-label="Saved servers"
      >
        <header className="settings-card-heading">
          <h4>Servers</h4>
          <span>{servers.length}</span>
        </header>
        {!servers.length && (
          <p className="settings-section-note">
            No servers yet. Add a connection below.
          </p>
        )}
        <div className="ssh-list">
          {servers.map((s) => (
            <article className="ssh-card" key={s.id}>
              <div className="ssh-item-heading">
                <ServerIcon size={18} aria-hidden="true" />
                <div>
                  <strong>{s.name}</strong>
                  <span className="ssh-wrap">
                    {s.username}@{s.host}:{s.port} · {s.alias}
                  </span>
                </div>
              </div>
              <span className="muted">
                {keys.find((k) => k.id === s.key_id)?.name} ·{" "}
                {s.host_keys.length
                  ? "Server fingerprint confirmed"
                  : "Fingerprint confirmation needed"}
              </span>
              {s.last_checked_at && (
                <p role="status">
                  {s.last_check_ok ? "Connected" : "Check failed"} ·{" "}
                  {new Date(s.last_checked_at).toLocaleString()}
                  <br />
                  {s.last_check_message}
                </p>
              )}
              <div className="ssh-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(s.id);
                    setForm({
                      name: s.name,
                      alias: s.alias,
                      host: s.host,
                      port: s.port,
                      username: s.username,
                      key_id: s.key_id,
                    });
                    setReview(null);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      setReview(null);
                      const scan = await api(`/servers/${s.id}/scan`, {});
                      setReview({ id: s.id, ...scan });
                    })
                  }
                >
                  Review fingerprint
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || !s.host_keys.length}
                  onClick={() =>
                    void act(async () => {
                      const r = await api(`/servers/${s.id}/test`, {});
                      setMessage(`${s.name}: ${r.message}`);
                    })
                  }
                >
                  Test connection
                </button>
                <button
                  type="button"
                  className="icon-button quiet-danger"
                  aria-label={"Remove server " + s.name}
                  title="Remove server"
                  disabled={busy}
                  onClick={() => {
                    if (
                      confirm(
                        `Remove server “${s.name}” and its project/chat connections? This does not revoke the key on the remote server.`,
                      )
                    )
                      void act(async () => {
                        await api(`/servers/${s.id}`, undefined, "DELETE");
                        if (editing === s.id) {
                          setEditing(null);
                          setForm(blankServer);
                        }
                        if (review?.id === s.id) setReview(null);
                      });
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {review?.id === s.id && (
                <div className="ssh-review">
                  <p>
                    Compare these fingerprints with your server console or
                    administrator before confirming. A scan alone does not
                    verify the server's identity.
                  </p>
                  {review.keys.map((k) => (
                    <p key={k.fingerprint}>
                      <span>{k.key.split(" ")[0]}</span>
                      <code className="ssh-wrap">{k.fingerprint}</code>
                    </p>
                  ))}
                  {!!s.host_keys.length && (
                    <details>
                      <summary>Previously confirmed keys</summary>
                      {s.host_keys.map((k) => (
                        <pre className="ssh-wrap" key={k}>
                          {k}
                        </pre>
                      ))}
                    </details>
                  )}
                  <div className="ssh-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(`/servers/${s.id}/trust`, {
                            token: review.token,
                          });
                          setReview(null);
                          setMessage(
                            "Server fingerprint confirmed. You can now test the connection.",
                          );
                        })
                      }
                    >
                      I verified these fingerprints
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => setReview(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      <details
        className="settings-disclosure"
        open={!!editing || !servers.length}
      >
        <summary>{editing ? "Edit server" : "Add server"}</summary>
        <form
          className="ssh-server-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api(
                editing ? `/servers/${editing}` : "/servers",
                form,
                editing ? "PATCH" : "POST",
              );
              setEditing(null);
              setForm(blankServer);
              setReview(null);
              setMessage(
                "Server saved. Review its fingerprint and test the connection.",
              );
            });
          }}
        >
          <fieldset disabled={busy}>
            <legend className="visually-hidden">
              {editing ? "Edit server" : "Add server"}
            </legend>
            {(
              [
                ["name", "Server name"],
                ["alias", "SSH alias"],
                ["host", "Address"],
                ["username", "SSH user"],
              ] as const
            ).map(([field, label]) => (
              <label className="field" key={field}>
                <span>{label}</span>
                <input
                  required
                  value={form[field]}
                  maxLength={
                    field === "host" ? 253 : field === "name" ? 100 : 63
                  }
                  pattern={
                    field === "alias" ? "[a-z][a-z0-9-]{0,62}" : undefined
                  }
                  placeholder={field === "alias" ? "production" : undefined}
                  onChange={(e) =>
                    setForm({ ...form, [field]: e.target.value })
                  }
                />
              </label>
            ))}
            <label className="field">
              <span>SSH port</span>
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) =>
                  setForm({ ...form, port: Number(e.target.value) })
                }
              />
            </label>
            <div className="field">
              <span>SSH key</span>
              <Select
                aria-label="SSH key"
                disabled={busy}
                required
                value={form.key_id}
                onChange={(e) => setForm({ ...form, key_id: e.target.value })}
              >
                <option value="">Choose a key</option>
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </Select>
            </div>
            {!keys.length && (
              <p className="muted">Create or import an SSH key above first.</p>
            )}
            <div className="ssh-actions settings-card-actions">
              <button className="primary" disabled={!keys.length}>
                {editing ? "Save server" : "Add server"}
              </button>
              {editing && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setEditing(null);
                    setForm(blankServer);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </fieldset>
        </form>
      </details>
    </section>
  );
}

export function SshAccess({
  scope,
  id,
  embedded = false,
}: {
  scope: "projects" | "chats";
  id: string;
  embedded?: boolean;
}) {
  const [servers, setServers] = useState<Server[]>([]),
    [selected, setSelected] = useState<string[]>([]);
  const [inherited, setInherited] = useState(false),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    setSaved(false);
    void Promise.all([
      api<Server[]>("/servers"),
      api(`/${scope}/${id}/servers`),
    ])
      .then(([s, a]) => {
        if (live) {
          setServers(s);
          setSelected(a.server_ids);
          setInherited(a.inherited);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [scope, id]);
  return (
    <section
      className={
        "ssh-access server-access-list" +
        (embedded ? " settings-section-body" : "")
      }
      aria-label="SSH server access"
    >
      {!embedded && <h3>Server access</h3>}
      <p className="settings-section-intro">
        {inherited
          ? "Access is inherited from this project, including all working copies."
          : "Choose servers for this " +
            (scope === "projects"
              ? "project and all its working copies."
              : "personal chat.")}
      </p>
      {!servers.length && !busy && (
        <div className="settings-section-empty">
          <ServerIcon size={20} aria-hidden="true" />
          <div>
            <strong>No servers available</strong>
            <span>Add a server in Settings → Servers &amp; SSH.</span>
          </div>
        </div>
      )}
      {busy && !servers.length && (
        <p className="muted" role="status">
          Loading servers…
        </p>
      )}
      <div className="server-access-rows">
        {servers.map((s) => (
          <label className="server-access-row" key={s.id}>
            <ServerIcon size={18} aria-hidden="true" />
            <span className="server-access-info">
              <strong>{s.name}</strong>
              <small>
                {s.username}@{s.host}:{s.port} · {s.alias}
              </small>
              {!s.host_keys.length && (
                <span className="server-access-unverified">
                  Fingerprint not confirmed
                </span>
              )}
            </span>
            <input
              type="checkbox"
              aria-label={"Allow access to " + s.name}
              disabled={busy || inherited}
              checked={selected.includes(s.id)}
              onChange={(e) => {
                setSaved(false);
                setSelected(
                  e.target.checked
                    ? [...selected, s.id]
                    : selected.filter((id) => id !== s.id),
                );
              }}
            />
          </label>
        ))}
      </div>
      {!!servers.length && (
        <p className="settings-section-note">
          Remote changes affect the real server.
          {inherited ? " Manage access in project settings." : ""}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!inherited && !!servers.length && (
        <div className="settings-section-footer">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              setSaved(false);
              try {
                await api(
                  `/${scope}/${id}/servers`,
                  { server_ids: selected },
                  "PUT",
                );
                setSaved(true);
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save access"}
          </button>
        </div>
      )}
      {saved && <p role="status">SSH access saved.</p>}
    </section>
  );
}
