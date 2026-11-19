import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Select } from "./Select";

type AwsSettings = {
  startUrl: string;
  ssoRegion: string;
  accountId: string;
  role: string;
  region: string;
  required?: boolean;
};
type AwsStatus = {
  settings: AwsSettings | null;
  identity: string | null;
  pending: boolean;
  challenge?: { url: string; code: string };
  problem?: string;
};
const empty: AwsSettings = {
  startUrl: "",
  ssoRegion: "",
  accountId: "",
  role: "",
  region: "",
  required: false,
};

export function AwsAccess({ projectId }: { projectId: string }) {
  const endpoint = "/projects/" + projectId + "/aws";
  const [view, setView] = useState<AwsStatus>();
  const [fields, setFields] = useState(empty);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let live = true;
    api<AwsStatus>(endpoint)
      .then((result) => {
        if (!live) return;
        setView(result);
        setFields(result.settings ?? empty);
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [endpoint]);

  useEffect(() => {
    if (!view?.pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await api<AwsStatus>(endpoint);
        if (!live) return;
        setView(result);
        setError("");
        if (result.pending) timer = setTimeout(poll, 2200);
      } catch (error) {
        if (!live) return;
        setError((error as Error).message);
        timer = setTimeout(poll, 4500);
      }
    }
    timer = setTimeout(poll, 1400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [endpoint, view?.pending]);

  async function action(work: () => Promise<AwsStatus>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setView(await work());
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const saved = await api<AwsStatus>(
        endpoint,
        {
          ...fields,
          region: fields.region.trim() || fields.ssoRegion,
        },
        "PUT",
      );
      setView(saved);
      setFields(saved.settings ?? empty);
      setEditing(false);
      return saved.identity ? saved : api<AwsStatus>(endpoint + "/connect", {});
    });
  }

  return (
    <div className="settings-section-body integration-settings">
      <p className="settings-section-intro">
        Connect an IAM Identity Center role for this project’s agents and
        terminals.
      </p>
      <p className="settings-section-note">
        Agents and terminals receive all permissions of the selected role. Use a
        dedicated permission set with only the access this project needs; start
        with read-only access. Approval prompts do not restrict AWS permissions.
      </p>
      {!view && !error && (
        <p className="muted" role="status">
          Loading AWS settings…
        </p>
      )}
      {view && !view.pending && (editing || !view.settings) && (
        <form className="integration-form" onSubmit={save}>
          <label className="field">
            <span>SSO start URL or Issuer URL</span>
            <input
              type="url"
              autoComplete="off"
              placeholder="https://my-company.awsapps.com/start"
              maxLength={300}
              value={fields.startUrl}
              required
              onChange={(e) =>
                setFields({ ...fields, startUrl: e.target.value })
              }
            />
          </label>
          <div className="integration-fields">
            <label className="field">
              <span>SSO region</span>
              <input
                placeholder="eu-west-1"
                autoComplete="off"
                maxLength={30}
                required
                value={fields.ssoRegion}
                onChange={(e) =>
                  setFields({ ...fields, ssoRegion: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>AWS region (optional)</span>
              <input
                placeholder={fields.ssoRegion || "Same as SSO region"}
                autoComplete="off"
                maxLength={30}
                value={fields.region}
                onChange={(e) =>
                  setFields({ ...fields, region: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>AWS account ID</span>
              <input
                inputMode="numeric"
                pattern="[0-9]{12}"
                placeholder="12 digits"
                autoComplete="off"
                maxLength={12}
                required
                value={fields.accountId}
                onChange={(e) =>
                  setFields({ ...fields, accountId: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Role or permission set name</span>
              <input
                placeholder="ReadOnlyAccess"
                autoComplete="off"
                maxLength={64}
                required
                value={fields.role}
                onChange={(e) => setFields({ ...fields, role: e.target.value })}
              />
            </label>
          </div>
          <div className="field">
            <span>AWS availability</span>
            <Select
              aria-label="AWS availability"
              disabled={busy}
              value={fields.required ? "required" : "optional"}
              onChange={(e) =>
                setFields({
                  ...fields,
                  required: e.target.value === "required",
                })
              }
            >
              <option value="optional">
                Optional — continue local work if AWS is unavailable
              </option>
              <option value="required">
                Required — block tasks and terminals without AWS
              </option>
            </Select>
          </div>
          <div className="settings-card-actions integration-actions">
            {editing && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setFields(view.settings ?? empty);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            )}
            <button className="primary" disabled={busy}>
              {busy
                ? "Saving…"
                : editing
                  ? "Save connection"
                  : "Continue to AWS"}
            </button>
          </div>
        </form>
      )}
      {view?.pending && (
        <section className="workspace-settings-card" aria-label="AWS sign-in">
          <header className="settings-card-heading">
            <h4>Sign in to AWS</h4>
          </header>
          {view.challenge ? (
            <>
              <p className="settings-section-note">
                Open AWS in your browser and enter this code. Workspace will
                pick up the sign-in automatically.
              </p>
              <div className="integration-actions">
                <code className="integration-code">{view.challenge.code}</code>
                <button
                  className="secondary"
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(view.challenge!.code);
                      setNotice("Code copied.");
                    } catch {
                      setNotice("Select and copy the code above.");
                    }
                  }}
                >
                  Copy code
                </button>
              </div>
            </>
          ) : (
            <p className="muted" role="status">
              Waiting for AWS to respond…
            </p>
          )}
          <div className="settings-card-actions integration-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() =>
                void action(() =>
                  api(endpoint + "/connect", undefined, "DELETE"),
                )
              }
            >
              Cancel sign-in
            </button>
            {view.challenge && (
              <a
                className="primary"
                href={view.challenge.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open AWS sign-in
              </a>
            )}
          </div>
        </section>
      )}
      {view?.settings && !view.pending && !editing && (
        <section
          className="workspace-settings-card"
          aria-label="AWS connection"
        >
          <header className="settings-card-heading">
            <h4>{view.settings.role}</h4>
            <span role="status">
              {view.problem
                ? "Needs attention"
                : view.identity
                  ? "Connected"
                  : "Signed out"}
            </span>
          </header>
          <p className="settings-section-note">
            Account {view.settings.accountId} · {view.settings.region}
          </p>
          <p className="settings-section-note">
            {view.settings.required
              ? "AWS is required for new tasks and terminals."
              : "If AWS is unavailable, new runs continue without it and show a warning."}
          </p>
          <div className="integration-actions">
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={() => void action(() => api(endpoint + "/connect", {}))}
            >
              {view.identity ? "Sign in again" : "Sign in"}
            </button>
            {view.identity && (
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await api<AwsStatus>(
                      endpoint + "/check",
                      {},
                    );
                    if (!result.problem && result.identity)
                      setNotice("AWS access verified.");
                    return result;
                  })
                }
              >
                Check access
              </button>
            )}
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setNotice("");
                setError("");
              }}
            >
              Edit connection
            </button>
            {view.identity && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void action(() => api(endpoint, undefined, "DELETE"))
                }
              >
                Disconnect
              </button>
            )}
          </div>
        </section>
      )}
      {(error || view?.problem) && (
        <p className="inline-error" role="alert">
          {error || view?.problem}
        </p>
      )}
      {notice && (
        <p className="settings-section-note integration-feedback" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
