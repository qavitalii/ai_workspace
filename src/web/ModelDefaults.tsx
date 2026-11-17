import { Select } from "./Select";
import { useState } from "react";
import { ModelOptions } from "./ModelOptions";
import { api } from "./api";

function ProviderDefaults({ provider, accounts, initial, onSaved }: any) {
  const matching = accounts.filter((a: any) => a.provider === provider);
  const [accountId, setAccountId] = useState(
    matching.find((a: any) => a.status === "ready")?.id ||
      matching[0]?.id ||
      "",
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  return (
    <form
      className="provider-defaults workspace-settings-card"
      onChange={() => setSaved(false)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const form = new FormData(e.currentTarget);
        setSaving(true);
        setError("");
        setSaved(false);
        try {
          const model = String(form.get("model") || "").trim();
          if (!model)
            throw new Error("Choose a model or enter its exact name.");
          await api(`/settings/models/${provider}`, {
            model,
            effort: form.get("effort") || "",
          });
          await onSaved();
          setSaved(true);
        } catch (e: any) {
          setError(e.message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <header className="settings-card-heading">
        <h4>{provider === "codex" ? "Codex" : "Claude Code"}</h4>
        <span>New chats</span>
      </header>
      <fieldset disabled={saving} className="form-fields">
        {matching.length > 1 && (
          <label className="field">
            <span>Load available models from</span>
            <Select
              aria-label="Load available models from"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {matching.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {!matching.length && (
          <p className="muted">
            Connect an account to load its models, or enter a model name below.
          </p>
        )}
        <ModelOptions
          provider={provider}
          accountId={accountId}
          initialModel={initial?.model || ""}
          initialEffort={initial?.effort || ""}
        />
        <div className="settings-card-actions">
          <button
            className="primary"
            aria-label={`Save ${provider === "codex" ? "Codex" : "Claude Code"} defaults`}
          >
            {saving ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </fieldset>
      {saved && (
        <p role="status" className="success">
          Saved for new chats. Existing chats keep their settings.
        </p>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </form>
  );
}
export function ModelDefaults({ accounts, defaults, onSaved }: any) {
  return (
    <section aria-label="Default models">
      <header className="workspace-settings-heading">
        <h3>Models</h3>
        <p className="muted">
          Set the starting model for each agent. Existing chats keep their
          settings.
        </p>
      </header>
      <div className="provider-defaults-grid">
        {["codex", "claude"].map((provider) => (
          <ProviderDefaults
            key={provider}
            provider={provider}
            accounts={accounts}
            initial={defaults?.[provider]}
            onSaved={onSaved}
          />
        ))}
      </div>
    </section>
  );
}
