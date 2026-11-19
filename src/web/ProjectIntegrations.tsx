import { useEffect, useState } from "react";
import { Select } from "./Select";
import { api } from "./api";

type Entry = {
  id: string;
  kind: "mcp" | "plugin";
  name: string;
  provider: "codex" | "claude" | "both";
  target: string;
  enabled: boolean;
};
const agentNames = {
  both: "Codex and Claude",
  codex: "Codex",
  claude: "Claude",
};

export function ProjectIntegrations({ projectId }: { projectId: string }) {
  const url = "/projects/" + projectId + "/integrations";
  const [entries, setEntries] = useState<Entry[]>([]);
  const [kind, setKind] = useState("mcp"),
    [provider, setProvider] = useState("both");
  const [name, setName] = useState(""),
    [target, setTarget] = useState(""),
    [token, setToken] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Entry[]>(url)
      .then((v) => {
        if (live) setEntries(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [url]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setEntries(await api<Entry[]>(url));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="settings-disclosure">
      <summary>MCP servers &amp; plugins</summary>
      <div className="settings-section-body integration-settings">
        <p className="settings-section-intro">
          Enabled connections apply to the next agent run in this project.
        </p>
        {entries.length > 0 && (
          <ul
            className="integration-list project-integration-list"
            aria-label="Configured connections"
          >
            {entries.map((entry) => (
              <li key={entry.id}>
                <div className="server-access-info">
                  <strong>{entry.name}</strong>
                  <small>
                    {entry.kind === "mcp" ? "MCP server" : "Plugin"} ·{" "}
                    {agentNames[entry.provider]}
                  </small>
                  <small>{entry.target}</small>
                </div>
                <div className="integration-actions">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      disabled={busy}
                      aria-label={"Enabled for " + entry.name}
                      onChange={() =>
                        void change(() =>
                          api(
                            url + "/" + entry.id,
                            { enabled: !entry.enabled },
                            "PATCH",
                          ),
                        )
                      }
                    />
                    Enabled
                  </label>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={"Remove " + entry.name}
                    onClick={() =>
                      void change(() =>
                        api(url + "/" + entry.id, undefined, "DELETE"),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="integration-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            void change(async () => {
              await api(url, {
                kind,
                name,
                target,
                provider,
                ...(kind === "mcp" ? { token } : {}),
              });
              setName("");
              setTarget("");
              setToken("");
            });
          }}
        >
          <fieldset disabled={busy} aria-label="New connection">
            <div className="integration-fields">
              <div className="field">
                <span>Connection type</span>
                <Select
                  aria-label="Connection type"
                  disabled={busy}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setTarget("");
                    setToken("");
                    setProvider(e.target.value === "mcp" ? "both" : "codex");
                  }}
                >
                  <option value="mcp">MCP server</option>
                  <option value="plugin">Plugin</option>
                </Select>
              </div>
              <div className="field">
                <span>Agent</span>
                <Select
                  aria-label="Agent"
                  disabled={busy}
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value);
                    if (kind === "plugin") setTarget("");
                  }}
                >
                  {kind === "mcp" && (
                    <option value="both">Codex and Claude</option>
                  )}
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </Select>
              </div>
            </div>
            <label className="field">
              <span>Connection name</span>
              <input
                required
                pattern="[a-z][a-z0-9_\-]*"
                maxLength={48}
                placeholder="docs"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                {kind === "mcp"
                  ? "HTTPS MCP endpoint"
                  : provider === "codex"
                    ? "Plugin in the working folder’s marketplace"
                    : "Plugin directory in the working folder"}
              </span>
              <input
                required
                type={kind === "mcp" ? "url" : "text"}
                placeholder={
                  kind === "mcp"
                    ? "https://example.com/mcp"
                    : provider === "codex"
                      ? "my-plugin@my-marketplace"
                      : "plugins/my-plugin"
                }
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            {kind === "mcp" && (
              <label className="field">
                <span>Bearer token (optional)</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </label>
            )}
            {kind === "plugin" && (
              <p className="settings-section-note">
                Choose a plugin you trust. Its tools and hooks run with the
                agent’s access.
              </p>
            )}
            <div className="settings-card-actions integration-actions">
              <button disabled={busy} className="primary">
                Add {kind === "mcp" ? "MCP server" : "plugin"}
              </button>
            </div>
          </fieldset>
        </form>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}
