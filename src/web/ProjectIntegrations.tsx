import { useEffect, useState } from "react";
import { api } from "./api";

type Entry = {
  id: string;
  kind: "mcp" | "plugin";
  name: string;
  provider: string;
  target: string;
  enabled: boolean;
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
      <p className="muted">
        Enabled connections apply to the next agent run in this project.
      </p>
      {entries.map((entry) => (
        <div className="workspace-settings-card" key={entry.id}>
          <strong>{entry.name}</strong>
          <p>
            {entry.provider} · {entry.target}
          </p>
          <label>
            <input
              type="checkbox"
              checked={entry.enabled}
              disabled={busy}
              onChange={() =>
                void change(() =>
                  api(
                    url + "/" + entry.id,
                    { enabled: !entry.enabled },
                    "PATCH",
                  ),
                )
              }
            />{" "}
            Enabled
          </label>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void change(() => api(url + "/" + entry.id, undefined, "DELETE"))
            }
          >
            Remove {entry.name}
          </button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
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
        <label className="field">
          Connection type
          <select
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
          </select>
        </label>
        <label className="field">
          Agent
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              if (kind === "plugin") setTarget("");
            }}
          >
            {kind === "mcp" && <option value="both">Codex and Claude</option>}
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label className="field">
          Connection name
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
          {kind === "mcp"
            ? "HTTPS MCP endpoint"
            : provider === "codex"
              ? "Plugin in the working folder’s marketplace"
              : "Plugin directory in the working folder"}
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
            Bearer token (optional)
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
        )}
        {kind === "plugin" && (
          <p className="muted">
            Choose a plugin you trust. Its tools and hooks run with the agent’s
            access.
          </p>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button disabled={busy} className="primary">
          Add {kind === "mcp" ? "MCP server" : "plugin"}
        </button>
      </form>
    </details>
  );
}
