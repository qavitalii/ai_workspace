import { useId, useState } from "react";
import { Check, LoaderCircle, MessageSquare, Send } from "lucide-react";
import {
  buildQuestionAnswers,
  emptyQuestionDraft,
  questionAnswers,
  type AgentQuestion,
  type QuestionDraft,
} from "../question-answers";
import { useAgentResponse } from "./useAgentResponse";

export function AgentQuestions({
  request,
  onAnswered,
}: {
  request: { id: string; questions: AgentQuestion[] };
  onAnswered: () => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, QuestionDraft>>({});
  const response = useAgentResponse(onAnswered);
  const prefix = useId();
  const answers = buildQuestionAnswers(request.questions, values);
  const count = request.questions.filter((q) =>
    questionAnswers(q, values[q.id]),
  ).length;
  const update = (id: string, change: Partial<QuestionDraft>) =>
    setValues((old) => ({
      ...old,
      [id]: { ...(old[id] || emptyQuestionDraft()), ...change },
    }));
  return (
    <form
      className="agent-request agent-question-card"
      aria-label="Questions from your agent"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!answers) return;
        if (await response.submit("/questions/" + request.id, { answers }))
          setValues({});
      }}
    >
      <div className="agent-request-heading">
        <span className="agent-request-icon">
          <MessageSquare size={16} />
        </span>
        <div>
          <strong>
            {response.sent ? "Answers sent" : "Your input is needed"}
          </strong>
          <p>
            {response.sent
              ? "Your agent can continue with your choices."
              : "Review the choices, then send your answers."}
          </p>
        </div>
        {response.sent && <Check size={16} />}
      </div>
      {!response.sent && (
        <div className="agent-question-list">
          {request.questions.map((q, i) => {
            const draft = values[q.id] || emptyQuestionDraft();
            const options = q.isSecret ? [] : q.options || [];
            const custom = !options.length || draft.custom;
            const id = `${prefix}-${i}`;
            return (
              <fieldset
                key={q.id}
                className="agent-question"
                disabled={response.busy}
              >
                <legend>
                  {q.header && (
                    <span className="agent-question-topic">{q.header}</span>
                  )}
                  {q.question}
                </legend>
                {!!options.length && (
                  <p className="agent-question-hint">
                    {q.multiSelect ? "Choose one or more" : "Choose one"}
                  </p>
                )}
                {!!options.length && (
                  <div className="agent-options">
                    {options.map((option, j) => {
                      const checked =
                        draft.selected.includes(option.label) &&
                        (q.multiSelect || !draft.custom);
                      return (
                        <label
                          key={j}
                          className={
                            "agent-option " + (checked ? "selected" : "")
                          }
                        >
                          <input
                            type={q.multiSelect ? "checkbox" : "radio"}
                            name={id}
                            checked={checked}
                            aria-labelledby={`${id}-${j}-label`}
                            aria-describedby={
                              option.description
                                ? `${id}-${j}-description`
                                : undefined
                            }
                            onChange={(e) =>
                              update(q.id, {
                                selected: q.multiSelect
                                  ? e.target.checked
                                    ? [...draft.selected, option.label]
                                    : draft.selected.filter(
                                        (v) => v !== option.label,
                                      )
                                  : [option.label],
                                ...(!q.multiSelect ? { custom: false } : {}),
                              })
                            }
                          />
                          <span>
                            <strong id={`${id}-${j}-label`}>
                              {option.label}
                            </strong>
                            {option.description && (
                              <small id={`${id}-${j}-description`}>
                                {option.description}
                              </small>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    {q.isOther !== false && (
                      <label
                        className={
                          "agent-option custom-option " +
                          (draft.custom ? "selected" : "")
                        }
                      >
                        <input
                          type={q.multiSelect ? "checkbox" : "radio"}
                          name={id}
                          checked={draft.custom}
                          aria-label="Write my own answer"
                          onChange={(e) =>
                            update(q.id, {
                              custom: e.target.checked,
                              ...(!q.multiSelect ? { selected: [] } : {}),
                            })
                          }
                        />
                        <span>
                          <strong>Write my own answer</strong>
                        </span>
                      </label>
                    )}
                  </div>
                )}
                {custom && (
                  <label className="agent-custom-answer">
                    <span>
                      {options.length ? "Your own answer" : "Your answer"}
                    </span>
                    {q.isSecret ? (
                      <input
                        type="password"
                        autoComplete="off"
                        required
                        maxLength={10000}
                        value={draft.text}
                        onChange={(e) => update(q.id, { text: e.target.value })}
                      />
                    ) : (
                      <textarea
                        rows={2}
                        required
                        maxLength={10000}
                        value={draft.text}
                        placeholder="Write your answer…"
                        onChange={(e) => update(q.id, { text: e.target.value })}
                      />
                    )}
                  </label>
                )}
              </fieldset>
            );
          })}
        </div>
      )}
      {response.error && (
        <p className="agent-request-error" role="alert">
          {response.error}
        </p>
      )}
      <div className="agent-request-footer">
        <span role="status">
          {response.sent
            ? "Response delivered"
            : `${count} of ${request.questions.length} answered`}
        </span>
        {response.sent ? (
          response.error && (
            <button
              type="button"
              className="secondary"
              disabled={response.busy}
              onClick={response.refresh}
            >
              Refresh chat
            </button>
          )
        ) : (
          <button className="primary" disabled={response.busy || !answers}>
            {response.busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Send size={14} />
            )}
            {response.busy ? "Sending…" : "Send answers"}
          </button>
        )}
      </div>
    </form>
  );
}
