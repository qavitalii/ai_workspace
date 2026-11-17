import { useEffect, useRef, useState } from "react";
import { Eraser, RotateCw } from "lucide-react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { socketUrl } from "./api";

export function Terminal({ chatId }: { chatId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerminal | null>(null);
  const [status, setStatus] = useState("Connecting");
  const [session, setSession] = useState(0);
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setStatus("Connecting");
    // Let layout settle, and cancel the discarded StrictMode mount before opening a socket.
    const start = requestAnimationFrame(() => {
      if (!ref.current || disposed) return;
      const t = new XTerminal({
        theme: {
          background: "#181b20",
          foreground: "#e0e3e8",
          cursor: "#b5c9ed",
          selectionBackground: "#3c4b63",
          black: "#2b3038",
          red: "#ef9292",
          green: "#9bd3ad",
          yellow: "#e3cc94",
          blue: "#98bbdf",
          magenta: "#c5a4d9",
          cyan: "#91cece",
          white: "#e1e4e8",
        },
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        lineHeight: 1.4,
        cursorStyle: "bar",
        cursorBlink: true,
        convertEol: true,
      });
      terminal.current = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(ref.current);
      fit.fit();
      const ws = new WebSocket(socketUrl(`/chats/${chatId}/terminal`));
      const resize = () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }),
          );
      };
      ws.onopen = () => {
        if (!disposed) {
          setStatus("Connected");
          resize();
          t.focus();
        }
      };
      ws.onmessage = (e) => {
        if (!disposed) {
          const m = JSON.parse(e.data);
          if (m.type === "terminal") t.write(m.data);
        }
      };
      ws.onclose = () => {
        if (!disposed) setStatus("Disconnected");
      };
      ws.onerror = () => {
        if (!disposed) setStatus("Disconnected");
      };
      const input = t.onData((data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "terminal", data }));
      });
      let frame = 0;
      const obs = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (
            !disposed &&
            ref.current?.clientWidth &&
            ref.current?.clientHeight
          ) {
            fit.fit();
            resize();
          }
        });
      });
      obs.observe(ref.current);
      cleanup = () => {
        cancelAnimationFrame(frame);
        obs.disconnect();
        input.dispose();
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
        terminal.current = null;
        t.dispose();
      };
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(start);
      cleanup();
    };
  }, [chatId, session]);
  return (
    <section className="terminal-panel" aria-label="Terminal session">
      <div className="terminal-toolbar">
        <span
          className={`terminal-status ${status.toLowerCase()}`}
          role="status"
        >
          <i />
          {status}
        </span>
        <div>
          {status === "Disconnected" && (
            <button
              className="text-button"
              onClick={() => setSession((v) => v + 1)}
            >
              <RotateCw size={14} />
              Reconnect
            </button>
          )}
          <button
            className="icon-button"
            title="Clear terminal"
            aria-label="Clear terminal"
            onClick={() => {
              terminal.current?.clear();
              terminal.current?.focus();
            }}
          >
            <Eraser size={15} />
          </button>
        </div>
      </div>
      <div className="terminal" ref={ref} />
    </section>
  );
}
