import { useRef, useState } from "react";
import { api } from "./api";

// A successful decision must never become retryable just because refreshing the chat failed.
export function useAgentResponse(onAnswered: () => Promise<void>) {
  const pending = useRef(false);
  const accepted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await onAnswered();
    } catch {
      setError(
        "Your response was sent, but the chat could not refresh. Try refreshing again.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function submit(path: string, body: unknown) {
    if (pending.current || accepted.current) return false;
    pending.current = true;
    setBusy(true);
    setError("");
    let success = false;
    try {
      await api(path, body);
      accepted.current = true;
      setSent(true);
      success = true;
      try {
        await onAnswered();
      } catch {
        setError(
          "Your response was sent, but the chat could not refresh. Try refreshing again.",
        );
      }
    } catch (e: any) {
      setError(e.message || "Unable to send your response. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
    return success;
  }
  return { busy, sent, error, submit, refresh };
}
