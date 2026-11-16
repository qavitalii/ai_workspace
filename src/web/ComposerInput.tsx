import { useEffect, useRef, useState } from "react";
import { api } from "./api";
export const chatCommands = [
  { name: "model", description: "Choose model and reasoning effort" },
  { name: "settings", description: "Chat settings and connected folders" },
  { name: "files", description: "Browse workspace files" },
  { name: "terminal", description: "Open the terminal" },
  { name: "stop", description: "Stop the current task" },
  { name: "new", description: "Create a new chat" },
  { name: "help", description: "Show supported commands and references" },
];
export function ComposerInput({
  chatId,
  value,
  onChange,
  onFiles,
  onSend,
  onCommand,
  drag,
}: {
  chatId: string;
  value: string;
  onChange: (v: string) => void;
  onFiles: (files: File[]) => void;
  onSend: () => void;
  onCommand: (name: string) => void;
  drag: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0),
    [index, setIndex] = useState(0),
    [dismissed, setDismissed] = useState(false),
    [entries, setEntries] = useState<any[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
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
      ? chatCommands
      : entries.filter((e) => e.kind === (symbol === "$" ? "skill" : "file"))
  )
    .filter((e) => e.name.toLowerCase().includes(query))
    .slice(0, 8);
  const open = !!symbol && !dismissed;
  function choose(item: any) {
    if (symbol === "/") {
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
              ? "Chat commands"
              : symbol === "$"
                ? "Workspace skills"
                : "Workspace files"
          }
        >
          <small>
            {symbol === "/"
              ? "Chat commands"
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
            : "Message your agent · / commands · @ files · $ skills"
        }
        rows={3}
        onKeyDown={(e) => {
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
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
        }}
      />
    </div>
  );
}
