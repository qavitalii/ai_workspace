import { useState } from "react";
import { api } from "./api";

export function ProjectSettings({
  project,
  onSaved,
}: {
  project: any;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          await api(
            "/projects/" + project.id,
            {
              name,
              ...(removeToken
                ? { token: null }
                : token.trim()
                  ? { token: token.trim() }
                  : {}),
            },
            "PATCH",
          );
          setToken("");
          await onSaved();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="muted">{project.repo}</p>
      <label className="field">
        <span>Project name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
      </label>
      <h3>GitHub access</h3>
      <p className="muted">
        {project.github_configured
          ? "A token is saved for this project only. Leave the field empty to keep it."
          : "No token is saved. Public repositories can be read without one; private access and publishing need a token."}
      </p>
      {!removeToken && (
        <label className="field">
          <span>
            {project.github_configured
              ? "Replace access token (optional)"
              : "Access token (optional)"}
          </span>
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            minLength={10}
            maxLength={500}
          />
        </label>
      )}
      <p className="muted">
        Select this repository in your fine-grained token. For publishing, allow
        Contents and Pull requests: read/write.
      </p>
      {project.github_configured && (
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setRemoveToken(!removeToken);
            setToken("");
          }}
        >
          {removeToken ? "Keep saved token" : "Remove saved token"}
        </button>
      )}
      {removeToken && (
        <p className="muted">The token will be removed when you save.</p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="project-save">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save project"}
        </button>
      </div>
    </form>
  );
}
