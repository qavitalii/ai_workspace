import { Check, LoaderCircle, ShieldCheck } from "lucide-react";
import { useAgentResponse } from "./useAgentResponse";

export function AgentPermission({
  request,
  onAnswered,
}: {
  request: { id: string; description: string; details: unknown };
  onAnswered: () => Promise<void>;
}) {
  const response = useAgentResponse(onAnswered);
  return (
    <section
      className="agent-request agent-permission-card"
      aria-label="Permission request"
    >
      <div className="agent-request-heading">
        <span className="agent-request-icon">
          <ShieldCheck size={16} />
        </span>
        <div>
          <strong>
            {response.sent ? "Decision sent" : "Permission needed"}
          </strong>
          <p>
            {response.sent
              ? "Your agent has received your decision."
              : "Review this action before allowing it."}
          </p>
        </div>
        {response.sent && <Check size={16} />}
      </div>
      {!response.sent && (
        <div className="agent-permission-body">
          <p className="agent-action-description">{request.description}</p>
          {request.details == null ? (
            <p className="agent-request-error" role="alert">
              Action details are unavailable. Deny this request and ask the
              agent to try again.
            </p>
          ) : (
            <details className="agent-action-details" open>
              <summary>Action details</summary>
              <pre tabIndex={0} aria-label="Action details">
                {typeof request.details === "string"
                  ? request.details
                  : JSON.stringify(request.details, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
      {response.error && (
        <p className="agent-request-error" role="alert">
          {response.error}
        </p>
      )}
      <div className="agent-request-footer">
        <span role="status">
          {response.busy
            ? "Sending decision…"
            : response.sent
              ? "Response delivered"
              : "The agent is waiting"}
        </span>
        <div>
          {response.sent ? (
            response.error && (
              <button
                className="secondary"
                disabled={response.busy}
                onClick={response.refresh}
              >
                Refresh chat
              </button>
            )
          ) : (
            <>
              <button
                className="secondary"
                disabled={response.busy}
                onClick={() =>
                  response.submit("/approvals/" + request.id, { allow: false })
                }
              >
                Deny
              </button>
              <button
                className="primary"
                disabled={response.busy || request.details == null}
                onClick={() =>
                  response.submit("/approvals/" + request.id, { allow: true })
                }
              >
                {response.busy && <LoaderCircle size={14} className="spin" />}
                Allow
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
