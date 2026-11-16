import { useState } from "react";
import { ModelOptions } from "./ModelOptions";

export function ChatModelPicker({ chat, onSave, onClose, onError }: any) {
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const data = new FormData(e.currentTarget);
        const model = String(data.get("model") || "").trim();
        if (!model) {
          onError("Choose a model first.");
          return;
        }
        setSaving(true);
        try {
          await onSave({ model, effort: String(data.get("effort") || "") });
        } catch (e: any) {
          onError(e.message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={saving} className="form-fields">
        <ModelOptions
          provider={chat.provider}
          accountId={chat.account_id}
          initialModel={chat.model || chat.resolved_model}
          initialEffort={chat.effort || chat.resolved_effort}
          compact
        />
        <div className="chat-dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{saving ? "Saving…" : "Apply"}</button>
        </div>
      </fieldset>
    </form>
  );
}
