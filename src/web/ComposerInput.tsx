import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ChatCommand } from "../commands";
export function ComposerInput({
  chatId,
  commands,
  provider,
  value,
  onChange,
  onFiles,
  onSend,
  onCommand,
  drag,
  busy,
}: {
  chatId: string;
  commands: ChatCommand[];
  provider: string;
  value: string;
  onChange: (v: string) => void;
  onFiles: (files: File[]) => void;
  onSend: () => void;
  onCommand: (name: string) => void;
  drag: boolean;
  busy: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0),
    [index, setIndex] = useState(0),
    [dismissed, setDismissed] = useState(false),
    [entries, setEntries] = useState<any[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!input.current) return;
    input.current.style.height = "auto";
    input.current.style.height =
      Math.min(input.current.scrollHeight, 180) + "px";
  }, [value]);
  const match = value.slice(0, cursor).match(/(?:^|\s)([/@$])([^\s]*)$/);
  const symbol = match?.[1],
    query = match?.[2]?.toLowerCase() || "";
  useEffect(() => {
    setDismissed(false);
    setIndex(0);
  }, [value, cursor]);
  useEffect(() => {
    if (!symbol || symbol === "/") return;
    let live = true;
    setLoading(true);
    setError("");
    api(`/chats/${chatId}/context`)
      .then((r) => {
        if (live) {
          setEntries(r.entries);
          if (!r.initialized)
            setError(
              "Workspace files and skills appear after the workspace is prepared. Connected folders are available now.",
            );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chatId, symbol]);
  const options = (
    symbol === "/"
      ? commands.filter((c) => !c.unavailable)
      : entries.filter((e) => e.kind === (symbol === "$" ? "skill" : "file"))
  ).filter((e) => e.name.toLowerCase().includes(query));
  const open = !!symbol && !dismissed;
  useEffect(() => {
    if (open)
      document
        .getElementById("suggestion-" + index)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, index]);
  function choose(item: any) {
    if (symbol === "/") {
      if (item.native) {
        onChange("/" + item.name + " ");
        setDismissed(true);
        input.current?.focus();
        return;
      }
      onChange(
        value.slice(0, cursor - (query.length + 1)) + value.slice(cursor),
      );
      onCommand(item.name);
    } else {
      const replacement =
        symbol === "$"
          ? `Use skill "${item.name}" at ${JSON.stringify(item.path)} `
          : `${JSON.stringify(item.path)} `;
      const start = cursor - query.length - 1;
      onChange(value.slice(0, start) + replacement + value.slice(cursor));
      requestAnimationFrame(() => {
        input.current?.focus();
        input.current?.setSelectionRange(
          start + replacement.length,
          start + replacement.length,
        );
        setCursor(start + replacement.length);
      });
    }
    setDismissed(true);
  }
  return (
    <div className="composer-input">
      {open && (
        <div
          className="composer-menu"
          role="listbox"
          id="composer-suggestions"
          aria-label={
            symbol === "/"
              ? provider === "codex"
                ? "Codex commands"
                : "Claude Code commands"
              : symbol === "$"
                ? "Workspace skills"
                : "Workspace files"
          }
        >
          <small>
            {symbol === "/"
              ? provider === "codex"
                ? "Codex commands"
                : "Claude Code commands"
              : symbol === "$"
                ? "Workspace skills"
                : "Workspace files"}{" "}
            · ↑ ↓ Enter · Esc
          </small>
          {loading && symbol !== "/" ? (
            <p>Loading…</p>
          ) : (
            options.map((item, i) => (
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                id={"suggestion-" + i}
                key={item.path || item.name}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(item)}
              >
                <strong>
                  {symbol}
                  {item.name}
                </strong>
                <small>{item.description || item.path}</small>
              </button>
            ))
          )}
          {!loading && !options.length && (
            <p>
              {symbol === "$"
                ? "No matching workspace skills. Add a SKILL.md file to the workspace."
                : "No matches."}
            </p>
          )}
          {symbol !== "/" && error && <p>{error}</p>}
        </div>
      )}
      <textarea
        ref={input}
        value={value}
        aria-label="Message"
        aria-controls={open ? "composer-suggestions" : undefined}
        aria-activedescendant={
          open && options[index] ? "suggestion-" + index : undefined
        }
        onChange={(e) => {
          onChange(e.target.value);
          setCursor(e.target.selectionStart);
        }}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files);
          if (files.length) {
            e.preventDefault();
            onFiles(files);
          }
        }}
        placeholder={
          drag
            ? "Drop your files here…"
            : busy
              ? "Write your next message while the agent works…"
              : "Describe a task or ask a question…"
        }
        rows={2}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open && e.key === "Escape") {
            e.preventDefault();
            setDismissed(true);
            return;
          }
          if (
            open &&
            options.length &&
            ["ArrowDown", "ArrowUp"].includes(e.key)
          ) {
            e.preventDefault();
            setIndex(
              (i) =>
                (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                options.length,
            );
            return;
          }
          if (
            open &&
            options[index] &&
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey
          ) {
            e.preventDefault();
            choose(options[index]);
            return;
          }
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            (e.metaKey ||
              e.ctrlKey ||
              matchMedia("(hover: hover) and (pointer: fine)").matches)
          ) {
            e.preventDefault();
            if (!busy) onSend();
          }
        }}
      />
    </div>
  );
}
