import { useState } from "react";
import { api } from "./api";
export function AgentQuestions({
  request,
  onAnswered,
}: {
  request: any;
  onAnswered: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="approval"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await api("/questions/" + request.id, {
            answers: Object.fromEntries(
              request.questions.map((q: any) => [
                q.id,
                { answers: [values[q.id]?.trim()] },
              ]),
            ),
          });
          await onAnswered();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <strong>Your agent has a question</strong>
        {request.questions.map((q: any) => (
          <fieldset key={q.id} disabled={busy}>
            <legend>{q.question}</legend>
            <div className="button-row">
              {q.options?.map((o: any) => (
                <button
                  type="button"
                  key={o.label}
                  className={values[q.id] === o.label ? "primary" : "secondary"}
                  onClick={() => setValues((v) => ({ ...v, [q.id]: o.label }))}
                  title={o.description}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span>
                Your answer
                {q.multiSelect ? " (you can name several choices)" : ""}
              </span>
              <input
                type={q.isSecret ? "password" : "text"}
                autoComplete="off"
                required
                maxLength={10000}
                value={values[q.id] || ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [q.id]: e.target.value }))
                }
              />
            </label>
          </fieldset>
        ))}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Sending…" : "Send answers"}
        </button>
      </div>
    </form>
  );
}
