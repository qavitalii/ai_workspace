import { useEffect, useRef, useState } from "react";
import { api } from "./api";

export function ModelOptions({
  provider,
  accountId,
  initialModel = "",
  initialEffort = "",
}: {
  provider: string;
  accountId: string;
  initialModel?: string;
  initialEffort?: string;
}) {
  const [model, setModel] = useState(initialModel),
    [effort, setEffort] = useState(initialEffort),
    [models, setModels] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const forceRefresh = useRef<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setModels([]);
    setError("");
    setModel(initialModel);
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
        if (generation.current === current) setModels(items);
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
    <div className="model-options">
      <label className="field">
        <span>Model</span>
        <select
          name="model"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setEffort("");
          }}
        >
          <option value="">Agent default</option>
          {model && !choices.some((m) => (m.model || m.id) === model) && (
            <option value={model}>{model}</option>
          )}
          {choices.map((m) => (
            <option key={m.id} value={m.model || m.id}>
              {m.displayName || m.id}
            </option>
          ))}
        </select>
      </label>
      {provider === "codex" && (
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
        <select
          name="effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">Agent default</option>
          {effort && !levels.includes(effort) && (
            <option value={effort}>
              {effort[0].toUpperCase() + effort.slice(1)} (saved)
            </option>
          )}
          {levels.map((l: string) => (
            <option key={l} value={l}>
              {l === "xhigh" ? "Extra high" : l[0].toUpperCase() + l.slice(1)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {advertised?.length
          ? "Options reported by the selected model."
          : "Availability depends on your account and model. Leave Agent default if unsure."}
      </p>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
