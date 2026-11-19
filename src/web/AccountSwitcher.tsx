import { useState } from "react";
import { ArrowRightLeft, Check, LoaderCircle } from "lucide-react";
import { ProviderIcon, providerName } from "./ProviderIcon";

type Account = { id: string; name: string; provider: string; status: string };

function unavailableReason(status: string) {
  switch (status) {
    case "limited":
      return "Usage limit reached";
    case "disconnected":
      return "Sign in to this account first";
    case "authenticating":
      return "Sign-in in progress";
    case "inspecting":
      return "Checking connection";
    case "disconnecting":
      return "Signing out";
    case "deleting":
      return "Being removed";
    case "disconnect_failed":
      return "Sign-out failed — reconnect in Agent accounts";
    case "delete_failed":
      return "Removal incomplete — check Agent accounts";
    default:
      return "Unavailable — check Agent accounts";
  }
}

export function AccountSwitcher({
  accounts,
  currentId,
  provider,
  runState,
  onSwitch,
  onManage,
  onCancel,
}: {
  accounts: Account[];
  currentId: string | null;
  provider: string;
  runState?: string;
  onSwitch: (id: string) => Promise<void>;
  onManage: () => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = accounts.find((a) => a.id === currentId);
  const alternatives = accounts.filter((a) => a.id !== currentId);
  const selected = alternatives.find(
    (a) => a.id === selectedId && a.status === "ready",
  );
  const blocked = ["running", "waiting_approval", "queued"].includes(
    runState || "",
  );
  async function confirm() {
    if (!selected || busy || blocked) return;
    setBusy(true);
    setError("");
    try {
      await onSwitch(selected.id);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not switch accounts. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="account-switcher">
      <div className="switch-current">
        <ProviderIcon provider={provider} size={24} />
        <div>
          <small>Current account · {providerName(provider)}</small>
          <strong>{current?.name || "No account selected"}</strong>
          {current && current.status !== "ready" && (
            <span>{unavailableReason(current.status)}</span>
          )}
        </div>
        <span className="switch-current-badge">Current</span>
      </div>
      <p className="switch-intro">
        Choose any connected Codex or Claude Code account to continue this chat.
      </p>
      {blocked && (
        <p className="switch-notice" role="status">
          {runState === "queued"
            ? "Cancel the queued task before switching accounts."
            : "Stop the current task before switching accounts."}{" "}
          Your conversation will stay here.
        </p>
      )}
      {alternatives.length ? (
        <fieldset className="switch-options" disabled={busy || blocked}>
          <legend>Switch to</legend>
          {alternatives.map((a) => {
            const available = a.status === "ready";
            const checked = available && a.id === selectedId;
            return (
              <label
                key={a.id}
                className={`switch-option${checked ? " selected" : ""}${available ? "" : " unavailable"}`}
              >
                <input
                  type="radio"
                  name="switch-account"
                  value={a.id}
                  checked={checked}
                  disabled={!available}
                  onChange={() => {
                    setSelectedId(a.id);
                    setError("");
                  }}
                />
                <ProviderIcon provider={a.provider} size={21} />
                <div>
                  <strong>{a.name}</strong>
                  <small>
                    {providerName(a.provider)} ·{" "}
                    {available
                      ? "Connected · Ready to use"
                      : unavailableReason(a.status)}
                  </small>
                </div>
                {checked && <Check size={18} aria-hidden="true" />}
              </label>
            );
          })}
        </fieldset>
      ) : (
        <div className="switch-empty">
          <strong>No other agent accounts</strong>
          <p>
            Add and connect another Codex or Claude Code account in Agent
            accounts to switch.
          </p>
        </div>
      )}
      <p className="switch-explanation">
        Your messages and files stay in this chat. The selected account starts a
        new agent session with a summary of previous work.
      </p>
      {selected && selected.provider !== provider && (
        <p className="switch-provider-note">
          Switching to {providerName(selected.provider)} uses its default model.
          Your planning mode and permission settings stay the same.
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="switch-footer">
        <button className="text-button" disabled={busy} onClick={onManage}>
          Manage accounts
        </button>
        <div>
          <button className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!selected || busy || blocked}
            onClick={() => void confirm()}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <ArrowRightLeft size={16} />
            )}
            {busy ? "Switching…" : "Switch account"}
          </button>
        </div>
      </div>
    </div>
  );
}
