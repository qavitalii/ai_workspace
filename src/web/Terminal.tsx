import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { socketUrl } from "./api";
export function Terminal({ chatId }: { chatId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = new XTerminal({
      theme: { background: "#171b19", foreground: "#e3e9e5" },
      fontSize: 14,
      cursorBlink: true,
      convertEol: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(ref.current!);
    fit.fit();
    const ws = new WebSocket(socketUrl(`/chats/${chatId}/terminal`));
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === "terminal") t.write(m.data);
    };
    ws.onclose = () => t.writeln("\r\n[Terminal disconnected]");
    t.onData((data) => {
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "terminal", data }));
    });
    const obs = new ResizeObserver(() => {
      fit.fit();
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: "resize", cols: t.cols, rows: t.rows }));
    });
    obs.observe(ref.current!);
    return () => {
      obs.disconnect();
      ws.close();
      t.dispose();
    };
  }, [chatId]);
  return <div className="terminal" ref={ref} />;
}
