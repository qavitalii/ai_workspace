import { Select } from "./Select";
import { effortLabel } from "../usage";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function ModelOptions({
  provider,
  accountId,
  initialModel = "",
  initialEffort = "",
  compact = false,
}: {
  provider: string;
  accountId: string;
  initialModel?: string;
  initialEffort?: string;
  compact?: boolean;
}) {
  const [model, setModel] = useState(initialModel),
    [effort, setEffort] = useState(initialEffort),
    [models, setModels] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [custom, setCustom] = useState(false);
  const generation = useRef(0);
  const forceRefresh = useRef<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setModels([]);
    setError("");
    setModel(initialModel || (provider === "claude" ? "sonnet" : ""));
    setEffort(initialEffort);
  }, [provider, accountId]);
  useEffect(() => {
    const current = ++generation.current;
    setError("");
    if (!accountId || provider !== "codex") {
      setBusy(false);
      return;
    }
    setBusy(true);
    api("/accounts/" + accountId + "/models", {
      refresh: forceRefresh.current === accountId,
    })
      .then((items) => {
        if (generation.current === current) {
          setModels(items);
          const preferred = items.find((m: any) => m.isDefault) || items[0];
          if (!initialModel && preferred) {
            setModel((current) => current || preferred.model || preferred.id);
            setEffort(initialEffort || preferred.defaultReasoningEffort || "");
          }
        }
      })
      .catch((e) => {
        if (generation.current === current)
          setError(
            e.message ===
              "The operation could not be completed. Check the server status."
              ? "The model list is temporarily unavailable. Try again."
              : e.message,
          );
      })
      .finally(() => {
        if (generation.current === current) setBusy(false);
      });
    forceRefresh.current = null;
    return () => {
      generation.current++;
    };
  }, [provider, accountId, refresh]);
  const selected = models.find((m) => (m.model || m.id) === model);
  const advertised = selected?.supportedReasoningEfforts?.map((e: any) =>
    typeof e === "string" ? e : e.reasoningEffort,
  );
  const levels = advertised?.length
    ? advertised
    : provider === "claude"
      ? ["low", "medium", "high"]
      : ["low", "medium", "high", "xhigh"];
  const choices = models.length
    ? models
    : provider === "claude"
      ? [{ id: "sonnet" }, { id: "opus" }, { id: "haiku" }]
      : [];
  return (
    <div
      className={"model-options " + (compact ? "model-options-compact" : "")}
    >
      <label className="field">
        <span>Model</span>
        {custom ? (
          <input
            name="model"
            value={model}
            maxLength={100}
            placeholder="Exact model name"
            onChange={(e) => {
              setModel(e.target.value);
              setEffort("");
            }}
          />
        ) : (
          <Select
            aria-label="Model"
            name="model"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              const next = models.find(
                (m) => (m.model || m.id) === e.target.value,
              );
              setEffort(next?.defaultReasoningEffort || "");
            }}
          >
            <option value="" disabled>
              {busy ? "Loading available models…" : "Choose a model"}
            </option>
            {model && !choices.some((m) => (m.model || m.id) === model) && (
              <option value={model}>{model}</option>
            )}
            {choices.map((m) => (
              <option key={m.id} value={m.model || m.id}>
                {m.displayName && m.displayName !== (m.model || m.id)
                  ? `${m.displayName} (${m.model || m.id})`
                  : m.model || m.id}
              </option>
            ))}
          </Select>
        )}
      </label>
      {!compact && (
        <button
          type="button"
          className="text-button"
          onClick={() => setCustom(!custom)}
        >
          {custom
            ? "Choose from available models"
            : "Enter an exact model name"}
        </button>
      )}
      {provider === "codex" && (!compact || !!error) && (
        <button
          type="button"
          className="text-button"
          disabled={!accountId || busy}
          onClick={() => {
            forceRefresh.current = accountId;
            setRefresh((n) => n + 1);
          }}
        >
          {busy
            ? "Loading models…"
            : error
              ? "Retry loading models"
              : "Refresh models"}
        </button>
      )}
      <label className="field">
        <span>Reasoning effort</span>
        <Select
          aria-label="Reasoning effort"
          name="effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">
            {selected?.defaultReasoningEffort
              ? `${effortLabel(selected.defaultReasoningEffort)} (recommended)`
              : "Chosen by the model"}
          </option>
          {effort && !levels.includes(effort) && (
            <option value={effort}>{effortLabel(effort)} (saved)</option>
          )}
          {levels.map((l: string) => (
            <option key={l} value={l}>
              {effortLabel(l)}
            </option>
          ))}
        </Select>
      </label>
      {!compact && (
        <p className="muted">
          {advertised?.length
            ? "Options reported by the selected model."
            : "Deeper thinking can help with complex tasks, but may take longer and use more of your limit."}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
