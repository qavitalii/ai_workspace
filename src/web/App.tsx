import { Select } from "./Select";
import { ChatModelPicker } from "./ChatModelPicker";
import { ModelDefaults } from "./ModelDefaults";
import { AccountUsage } from "./AccountUsage";
import { modelLabel, effortLabel } from "../usage";
import { SidebarNavigation } from "./Sidebar";
import { WorkspaceHome } from "./WorkspaceHome";
import { AgentQuestions } from "./AgentQuestions";
import { GithubTokenHelp } from "./GithubTokenHelp";
import { commandsFor, slashCommand } from "../commands";
import { ComposerInput } from "./ComposerInput";
import { ModelOptions } from "./ModelOptions";
import { Folders } from "./Folders";
import {
  cleanTerminalText,
  claudeSignInUrl,
  attachmentNotice,
  normalizeGithubRepo,
} from "../shared";
import {
  useEffect,
  lazy,
  Suspense,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Plus,
  FolderGit2,
  Settings,
  PanelLeftClose,
  Menu,
  Paperclip,
  X,
  ChevronDown,
  Check,
  Copy,
  Square,
  Terminal as TerminalIcon,
  Files,
  GitBranch,
  ChevronRight,
  ExternalLink,
  Bell,
  LogOut,
  RefreshCw,
  ShieldCheck,
  ArrowRightLeft,
  LoaderCircle,
  Download,
  FileText,
  Image as ImageIcon,
  Activity,
  CircleHelp,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, upload, socketUrl } from "./api";
import { ServerSettings } from "./ServerSettings";
import { ProjectSettings } from "./ProjectSettings";
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);
const labels: Record<string, string> = {
  queued: "Queued",
  running: "Working",
  waiting_approval: "Awaiting approval",
  waiting_account: "Account needed",
  completed: "Completed",
  failed: "Error",
  interrupted: "Interrupted",
  cancelled: "Stopped",
  ready: "Connected",
  disconnected: "Disconnected",
  limited: "Limit reached",
  authenticating: "Signing in…",
  inspecting: "Checking…",
  disconnecting: "Disconnecting…",
  disconnect_failed: "Sign-out failed",
};
function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={"mark " + (small ? "small" : "")}>
      w<span>·</span>
    </span>
  );
}
function Modal({
  title,
  children,
  onClose,
  className = "",
  error,
}: {
  className?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
  error?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const errorNotice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorNotice.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      className={"modal " + className}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const bounds = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < bounds.left ||
            e.clientX > bounds.right ||
            e.clientY < bounds.top ||
            e.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </header>
      {error && (
        <p ref={errorNotice} className="inline-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...p }) => (
            <a {...p} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src?.startsWith("/api/") ? (
              <img src={src} alt={alt} />
            ) : (
              <span>[Image: {alt}]</span>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await api("/login", { password: f.get("password"), code: f.get("code") });
      onLogin();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login">
      <div className="login-brand">
        <Mark />
        <span>workspace</span>
      </div>
      <section>
        <div className="eyebrow">YOUR AGENTS. YOUR SERVER.</div>
        <h1>
          Your workspace,
          <br />
          always within reach.
        </h1>
        <p>
          Pick up right where you left off.
          <br />
          Your agents are ready on your server.
        </p>
        <form onSubmit={submit}>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </Field>
          <Field label="Authenticator code">
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="6-digit code"
              required
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <ShieldCheck size={18} />
            )}
            Sign in to Workspace
          </button>
        </form>
        <small>Use the six-digit code from your authenticator app.</small>
      </section>
      <footer>
        <span className="dot" /> Running independently of your device
      </footer>
    </main>
  );
}
export function App() {
  const [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [overview, setOverview] = useState<any>({
      projects: [],
      chats: [],
      accounts: [],
    }),
    [chatId, setChatId] = useState<string | null>(
      new URLSearchParams(location.search).get("chat"),
    ),
    [projectId, setProjectId] = useState<string | null>(
      new URLSearchParams(location.search).get("project"),
    ),
    [newProjectId, setNewProjectId] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [modal, setModal] = useState(""),
    [editingChat, setEditingChat] = useState<any>(null),
    [chatActionBusy, setChatActionBusy] = useState(false),
    [editingProject, setEditingProject] = useState<any>(null),
    [error, setError] = useState(""),
    [mobile, setMobile] = useState(false),
    [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [streams, setStreams] = useState<Record<string, string>>({}),
    [liveLogs, setLiveLogs] = useState<any[]>([]),
    [connected, setConnected] = useState(false);
  const [text, setText] = useState(""),
    [drafts, setDrafts] = useState<any[]>([]),
    [sending, setSending] = useState(false),
    [drag, setDrag] = useState(false);
  const clientId = useRef(crypto.randomUUID()),
    fileInput = useRef<HTMLInputElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    textDrafts = useRef<Record<string, string>>({}),
    currentChat = useRef(chatId);
  currentChat.current = chatId;
  const loadOverview = () => api("/overview").then(setOverview);
  useEffect(() => {
    if (chatId) textDrafts.current[chatId] = text;
  }, [text]);
  useEffect(() => {
    setError("");
  }, [modal]);
  useEffect(() => {
    function pop() {
      const params = new URLSearchParams(location.search);
      setChatId(params.get("chat"));
      setProjectId(params.get("project"));
      setDetail(null);
      setPanel("");
      setMobile(false);
    }
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    function resize() {
      if (viewport && viewport.scale === 1)
        document.documentElement.style.setProperty(
          "--app-height",
          `${viewport.height}px`,
        );
    }
    resize();
    viewport?.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);
  useEffect(() => {
    const media = matchMedia("(max-width: 760px)");
    const close = () => {
      if (!media.matches) setMobile(false);
    };
    media.addEventListener("change", close);
    return () => media.removeEventListener("change", close);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement;
    const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
    const controls = () =>
      Array.from(
        sidebar.querySelectorAll<HTMLElement>("button, input, a[href]"),
      ).filter((el) => !el.closest("[hidden]") && !el.hasAttribute("disabled"));
    controls()[0]?.focus();
    function keyboard(e: KeyboardEvent) {
      if (e.key === "Escape") setMobile(false);
      if (e.key !== "Tab" || document.querySelector("dialog[open]")) return;
      const items = controls(),
        first = items[0],
        last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("keydown", keyboard);
      if (previous?.isConnected && previous.getClientRects().length)
        previous.focus();
    };
  }, [mobile]);
  useEffect(() => {
    if (!me?.ok) return;
    const timer = setInterval(() => {
      if (!document.hidden) void loadOverview().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [me?.ok]);
  const loadDetail = async (id = chatId) => {
    if (id) {
      const d = await api("/chats/" + id);
      if (currentChat.current === id) {
        setDetail(d);
        setDrafts((prev) => {
          const pending = d.attachments.filter((x: any) => !x.message_id);
          return [...pending, ...prev.filter((x: any) => !x.id)];
        });
      }
    }
  };
  async function refresh() {
    try {
      setMe(await api("/me"));
      await loadOverview();
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!me || !chatId) {
      setDetail(null);
      return;
    }
    setStreams({});
    setLiveLogs([]);
    setText(textDrafts.current[chatId] || "");
    setDrafts([]);
    setConnected(false);
    nearBottom.current = true;
    clientId.current = crypto.randomUUID();
    void loadDetail(chatId).catch((e) => setError(e.message));
    let ws: WebSocket,
      timer: ReturnType<typeof setTimeout>,
      dead = false,
      cursor = "0";
    function connect() {
      if (dead) return;
      ws = new WebSocket(
        socketUrl("/events?chat_id=" + chatId + "&after=" + cursor),
      );
      ws.onopen = () => {
        if (!dead) setConnected(true);
      };
      ws.onmessage = (e) => {
        if (dead) return;
        const ev = JSON.parse(e.data);
        if (BigInt(ev.id) <= BigInt(cursor)) return;
        cursor = ev.id;
        if (ev.type === "delta")
          setStreams((s) => ({
            ...s,
            [ev.job_id]: (s[ev.job_id] || "") + ev.data.text,
          }));
        if (["tool", "log", "handoff"].includes(ev.type))
          setLiveLogs((s) => [...s.slice(-149), ev]);
        if (
          [
            "status",
            "approval",
            "handoff",
            "request_resolved",
            "commands",
            "model",
            "limits",
          ].includes(ev.type)
        ) {
          void loadDetail(chatId);
          void loadOverview();
        }
      };
      ws.onclose = () => {
        if (dead) return;
        setConnected(false);
        if (!dead) timer = setTimeout(connect, 1500);
      };
    }
    connect();
    return () => {
      dead = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [me?.ok, chatId]);
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [detail?.messages.length, streams]);
  useEffect(() => {
    let active = true;
    setResults([]);
    setSearchError("");
    setSearching(!!query.trim());
    if (!query.trim()) return;
    const t = setTimeout(() => {
      const local = overview.chats.filter((c: any) =>
        c.title.toLowerCase().includes(query.trim().toLowerCase()),
      );
      api("/search?q=" + encodeURIComponent(query.trim()))
        .then((found) => {
          if (!active) return;
          const merged = [
            ...local,
            ...found.map((c: any) => ({
              ...c,
              ...overview.chats.find((item: any) => item.id === c.id),
            })),
          ];
          setResults([...new Map(merged.map((c: any) => [c.id, c])).values()]);
        })
        .catch(() => {
          if (active) {
            setResults(local);
            setSearchError(
              "Message search is unavailable. Showing matching chat titles.",
            );
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [query, overview.chats]);
  const run = async (fn: () => Promise<any>) => {
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };
  function selectChat(id: string) {
    if (id !== chatId) setDetail(null);
    setChatId(id);
    setProjectId(null);
    setMobile(false);
    setPanel("");
    setError("");
    history.pushState(null, "", "?chat=" + id);
  }
  function selectProject(id: string | null) {
    setChatId(null);
    setDetail(null);
    setProjectId(id);
    setMobile(false);
    setPanel("");
    setQuery("");
    setError("");
    history.pushState(null, "", id ? "?project=" + id : location.pathname);
  }
  function newChat(id: string | null = chat?.project_id || projectId) {
    setNewProjectId(id);
    setModal("chat");
    setMobile(false);
  }
  async function manageChat(c: any, action: "rename" | "delete") {
    if (action === "rename") {
      await api(`/chats/${c.id}/title`, { title: c.title }, "PATCH");
      setOverview((o: any) => ({
        ...o,
        chats: o.chats.map((item: any) =>
          item.id === c.id ? { ...item, title: c.title } : item,
        ),
      }));
      setDetail((d: any) =>
        d?.chat.id === c.id ? { ...d, chat: { ...d.chat, title: c.title } } : d,
      );
      return;
    }
    setEditingChat(c);
    setModal("delete-chat");
    setMobile(false);
  }
  function projectSettings(p: any) {
    setEditingProject(p);
    setModal("project-settings");
  }
  async function addFiles(files: File[]) {
    if (!chatId) return;
    if (drafts.length + files.length > me.maxAttachments) {
      setError(`Maximum ${me.maxAttachments} attachments`);
      return;
    }
    for (const file of files) {
      if (file.size > me.maxFileBytes) {
        setError(`${file.name}: file is too large`);
        continue;
      }
      const key = crypto.randomUUID(),
        item = { key, name: file.name, mime: file.type, progress: 0, file };
      setDrafts((d) => [...d, item]);
      try {
        const saved = await upload(chatId, file, key, (progress) =>
          setDrafts((d) =>
            d.map((x) => (x.key === key ? { ...x, progress } : x)),
          ),
        );
        if (currentChat.current === chatId)
          setDrafts((d) => d.map((x) => (x.key === key ? saved : x)));
      } catch (e: any) {
        setDrafts((d) =>
          d.map((x) => (x.key === key ? { ...x, error: e.message } : x)),
        );
      }
    }
  }
  async function retryUpload(f: any) {
    if (!chatId) return;
    setDrafts((d) =>
      d.map((x) => (x.key === f.key ? { ...x, error: null } : x)),
    );
    try {
      const saved = await upload(chatId, f.file, f.key, (progress) =>
        setDrafts((d) =>
          d.map((x) => (x.key === f.key ? { ...x, progress } : x)),
        ),
      );
      setDrafts((d) => d.map((x) => (x.key === f.key ? saved : x)));
    } catch (e: any) {
      setDrafts((d) =>
        d.map((x) => (x.key === f.key ? { ...x, error: e.message } : x)),
      );
    }
  }
  const chatCommands = commandsFor(
    detail?.chat.provider || "codex",
    detail?.chat.native_commands || [],
  );
  function command(name: string) {
    if (name === "plan")
      void run(async () => {
        await api(`/chats/${chatId}/mode`, { mode: "plan" });
        await loadDetail();
      });
    if (["permissions", "rename"].includes(name)) setModal("chat-settings");
    if (["status", "usage"].includes(name)) setModal("chat-status");
    if (name === "clear") newChat();
    if (name === "diff") setPanel("diff");
    if (name === "mention") setText("@");
    if (name === "skills") setText("$");
    if (name === "resume") setModal("resume-chat");
    if (name === "new") newChat();
    if (name === "model") setModal("chat-model");
    if (name === "settings") setModal("chat-settings");
    if (name === "files" || name === "terminal") setPanel(name);
    if (name === "stop" && chatId)
      void run(async () => {
        await api(`/chats/${chatId}/stop`, {});
        await loadDetail();
      });
    if (name === "help") setModal("composer-help");
  }
  async function send() {
    if (busy || sending) return;
    const shortcut = slashCommand(text);
    if (shortcut) {
      const selected = chatCommands.find((c) => c.name === shortcut.name);
      if (!selected || selected.unavailable) {
        setError(
          selected?.unavailable ||
            "Unknown command. Type / to see available commands.",
        );
        return;
      }
      if (
        !selected.native &&
        !(shortcut.name === "plan" && shortcut.arguments)
      ) {
        if (shortcut.arguments) {
          setError(
            "Use /" +
              shortcut.name +
              " without arguments to open its controls.",
          );
          return;
        }
        setText("");
        command(shortcut.name);
        return;
      }
    }

    if (
      !chatId ||
      sending ||
      drafts.some((f) => !f.id) ||
      (!text.trim() && !drafts.length)
    )
      return;
    setSending(true);
    const sentChatId = chatId;
    try {
      await api(`/chats/${chatId}/messages`, {
        content: text,
        client_id: clientId.current,
        attachment_ids: drafts.map((f) => f.id),
      });
      textDrafts.current[sentChatId] = "";
      if (currentChat.current === sentChatId) {
        clientId.current = crypto.randomUUID();
        setText("");
        setDrafts([]);
      }
      await loadDetail();
      await loadOverview();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }
  const chat = detail?.chat,
    job = detail?.jobs?.[0],
    busy =
      job &&
      ["queued", "running", "waiting_approval", "waiting_account"].includes(
        job.state,
      ),
    project = overview.projects.find(
      (p: any) =>
        p.id ===
        (chat?.project_id ||
          overview.chats.find((c: any) => c.id === chatId)?.project_id ||
          projectId),
    ),
    account = overview.accounts.find((a: any) => a.id === chat?.account_id);
  if (loading)
    return (
      <div className="splash">
        <Mark />
        <LoaderCircle className="spin" />
      </div>
    );
  if (!me) return <Login onLogin={refresh} />;
  return (
    <div className="app">
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        className={"sidebar " + (mobile ? "open" : "")}
      >
        <div className="brand">
          <Mark small />
          <strong>workspace</strong>
          <button
            className="icon mobile-only"
            onClick={() => setMobile(false)}
            aria-label="Close menu"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>
        <SidebarNavigation
          accounts={overview.accounts}
          onRefreshAccounts={loadOverview}
          projects={overview.projects}
          chats={overview.chats}
          chatId={chatId}
          projectId={project?.id}
          query={query}
          results={results}
          searching={searching}
          searchError={searchError}
          onQuery={setQuery}
          onChat={selectChat}
          onManage={manageChat}
          onProject={selectProject}
          onHome={() => selectProject(null)}
          onNew={newChat}
          onAddProject={() => setModal("project")}
          onProjectSettings={projectSettings}
        />
        <div className="sidebar-bottom">
          <button onClick={() => setModal("accounts")}>
            <Activity size={17} />
            Agent accounts
            <span className="count" title="Saved accounts">
              {overview.accounts.length}
            </span>
          </button>
          <button onClick={() => setModal("settings")}>
            <Settings size={17} />
            Settings
          </button>
          <div className="owner">
            <span className="avatar">Y</span>
            <div>
              <strong>Personal workspace</strong>
              <small>
                <span className="dot" /> Server workspace
              </small>
            </div>
            <button
              className="icon"
              aria-label="Sign out"
              onClick={() =>
                run(async () => {
                  await api("/logout", {});
                  setMe(null);
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && (
        <div className="sidebar-overlay" onClick={() => setMobile(false)} />
      )}
      <main className="main" inert={mobile || undefined}>
        <header className="topbar">
          <button
            className="icon mobile-only"
            aria-label="Open menu"
            aria-expanded={mobile}
            aria-controls="workspace-navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <button
              className="breadcrumb-project"
              onClick={() => selectProject(chat ? project?.id || null : null)}
            >
              {chat ? project?.name || "Personal chats" : "Workspace"}
            </button>
            <ChevronRight size={14} />
            <strong>{chat?.title || project?.name || "Home"}</strong>
          </div>
          <div className="top-actions">
            {chat && (
              <>
                <span className={"connection " + (connected ? "online" : "")}>
                  {connected ? "Live" : "Connecting…"}
                </span>
                <button
                  className={
                    "icon labeled-action " + (panel === "files" ? "active" : "")
                  }
                  aria-pressed={panel === "files"}
                  title="Files"
                  aria-label="Files"
                  onClick={() => setPanel(panel === "files" ? "" : "files")}
                >
                  <Files size={18} />
                  <span>Files</span>
                </button>
                {chat.project_id && (
                  <button
                    className={
                      "icon labeled-action " +
                      (panel === "diff" ? "active" : "")
                    }
                    aria-pressed={panel === "diff"}
                    title="Changes"
                    aria-label="Changes"
                    onClick={() => setPanel(panel === "diff" ? "" : "diff")}
                  >
                    <GitBranch size={18} />
                    <span>Changes</span>
                  </button>
                )}
                <button
                  className={
                    "icon labeled-action " +
                    (panel === "terminal" ? "active" : "")
                  }
                  aria-pressed={panel === "terminal"}
                  title="Terminal"
                  aria-label="Terminal"
                  onClick={() =>
                    setPanel(panel === "terminal" ? "" : "terminal")
                  }
                >
                  <TerminalIcon size={18} />
                  <span>Terminal</span>
                </button>
                <button
                  className="icon labeled-action"
                  title="Chat settings"
                  aria-label="Chat settings"
                  onClick={() => setModal("chat-settings")}
                >
                  <Settings size={18} />
                  <span>Settings</span>
                </button>
              </>
            )}
            {!chat && (
              <button
                className="icon mobile-only"
                aria-label="New chat"
                onClick={() => newChat()}
              >
                <Plus size={20} />
              </button>
            )}
          </div>
        </header>
        {error && !modal && (
          <div role="alert" className="error-banner">
            {error}
            <button
              className="icon"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {chatId && !chat ? (
          <div className="content-loading" role="status">
            {error ? (
              <button
                className="secondary"
                onClick={() => run(() => loadDetail())}
              >
                Retry loading chat
              </button>
            ) : (
              <>
                <LoaderCircle className="spin" size={22} />
                Loading chat…
              </>
            )}
          </div>
        ) : !chat ? (
          <WorkspaceHome
            project={project}
            overview={overview}
            onNew={newChat}
            onChat={selectChat}
            onAccounts={() => setModal("accounts")}
            onProject={selectProject}
            onAddProject={() => setModal("project")}
            onSettings={projectSettings}
          />
        ) : (
          <div className={"workspace " + (panel ? "with-panel" : "")}>
            <section className="conversation">
              <div className="chat-meta">
                <span className={"provider " + chat.provider}>
                  {chat.provider === "codex" ? "◈ Codex" : "✳ Claude Code"}
                </span>
                <button onClick={() => setModal("switch")}>
                  {account?.name || "Account"}
                  <ArrowRightLeft size={13} />
                </button>
                <span className="chat-mode">
                  {chat.mode === "plan"
                    ? "Plan mode"
                    : chat.autonomous
                      ? "Autonomous"
                      : "With approvals"}
                </span>
              </div>
              {account && account.status === "disconnected" && (
                <div className="run-notice">
                  <p>Connect {account.name} to run tasks in this chat.</p>
                  <button
                    className="secondary"
                    onClick={() => setModal("accounts")}
                  >
                    Connect account
                  </button>
                </div>
              )}
              <div
                className="messages"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  nearBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                }}
              >
                {!detail.messages.length && (
                  <div className="chat-start">
                    <span className="agent-orb">
                      {chat.provider === "codex" ? "◈" : "✳"}
                    </span>
                    <h2>What are we working on?</h2>
                    <p>
                      Describe a task or attach files.
                      <br />
                      {chat.project_id
                        ? "A separate branch will be created for this chat."
                        : "Your files and conversation stay together in this chat."}
                    </p>
                    <span className="branch-label">
                      <GitBranch size={14} />
                      {chat.project_id ? chat.branch : "Private workspace"}
                    </span>
                  </div>
                )}
                {!detail.messages.length && (
                  <div
                    className="prompt-suggestions"
                    aria-label="Ideas to get started"
                  >
                    {(chat.project_id
                      ? [
                          "Explain how this project works",
                          "Find and help me fix a bug",
                          "Help me plan a new feature",
                        ]
                      : [
                          "Help me plan a project",
                          "Review a file I attach",
                          "Write a script for a task",
                        ]
                    ).map((prompt) => (
                      <button
                        key={prompt}
                        onClick={() => {
                          setText(prompt);
                          document
                            .querySelector<HTMLTextAreaElement>(
                              ".composer textarea",
                            )
                            ?.focus();
                        }}
                      >
                        {prompt}
                        <ChevronRight size={15} />
                      </button>
                    ))}
                  </div>
                )}
                {job?.state === "queued" && (
                  <div className="run-notice" role="status">
                    <strong>Task queued</strong>
                    <p>
                      Your task will start when an account and server capacity
                      are available.
                    </p>
                  </div>
                )}
                {detail.messages.map((m: any) => (
                  <article className={"message " + m.role} key={m.id}>
                    <div className="message-avatar">
                      {m.role === "user"
                        ? "Y"
                        : chat.provider === "codex"
                          ? "◈"
                          : "✳"}
                    </div>
                    <div className="message-content">
                      <div className="message-heading">
                        {m.role === "user"
                          ? "You"
                          : chat.provider === "codex"
                            ? "Codex"
                            : "Claude Code"}
                        <time>
                          {new Date(m.created_at).toLocaleTimeString("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <Markdown text={m.content} />
                      <div className="message-files">
                        {detail.attachments
                          .filter((f: any) => f.message_id === m.id)
                          .map((f: any) => (
                            <Attachment key={f.id} file={f} />
                          ))}
                      </div>
                    </div>
                  </article>
                ))}
                {job && ["running", "waiting_approval"].includes(job.state) && (
                  <article className="message assistant">
                    <div className="message-avatar">◈</div>
                    <div className="message-content">
                      <div className="message-heading">
                        {labels[job.state]}
                        <LoaderCircle size={13} className="spin" />
                      </div>
                      <Markdown
                        text={
                          streams[job.id] ||
                          "Your agent is preparing the workspace…"
                        }
                      />
                    </div>
                  </article>
                )}
                {(liveLogs.length > 0 || detail.events.length > 0) && (
                  <details className="activity">
                    <summary>
                      <TerminalIcon size={14} />
                      Actions and execution log
                      <ChevronDown size={13} />
                    </summary>
                    {(liveLogs.length ? liveLogs : detail.events)
                      .slice(-60)
                      .map((e: any) => (
                        <pre key={e.id}>
                          {e.type === "handoff"
                            ? "↔ " + e.data.message
                            : e.type === "log"
                              ? e.data.text
                              : JSON.stringify(e.data.item || e.data, null, 2)}
                        </pre>
                      ))}
                  </details>
                )}
                {detail.approvals.map((a: any) =>
                  a.kind === "question" ? (
                    <AgentQuestions
                      key={a.id}
                      request={a}
                      onAnswered={loadDetail}
                    />
                  ) : (
                    <div className="approval" key={a.id}>
                      <ShieldCheck size={20} />
                      <div>
                        <strong>Your permission is needed</strong>
                        <pre>{a.description}</pre>
                        <div className="button-row">
                          <button
                            className="primary"
                            onClick={() =>
                              run(async () => {
                                await api("/approvals/" + a.id, {
                                  allow: true,
                                });
                                await loadDetail();
                              })
                            }
                          >
                            Allow
                          </button>
                          <button
                            className="secondary"
                            onClick={() =>
                              run(async () => {
                                await api("/approvals/" + a.id, {
                                  allow: false,
                                });
                                await loadDetail();
                              })
                            }
                          >
                            Deny
                          </button>
                        </div>
                      </div>
                    </div>
                  ),
                )}
                {job &&
                  ["failed", "interrupted", "waiting_account"].includes(
                    job.state,
                  ) && (
                    <div className="run-notice">
                      <strong>{labels[job.state]}</strong>
                      <p>
                        {job.error || "Review the changes before continuing."}
                      </p>
                      <button
                        className="secondary"
                        onClick={() =>
                          job.state === "waiting_account"
                            ? setModal("switch")
                            : run(async () => {
                                await api(`/chats/${chatId}/continue`, {});
                                await loadDetail();
                              })
                        }
                      >
                        {job.state === "waiting_account"
                          ? "Choose another account"
                          : "Resume and check existing work"}
                      </button>
                    </div>
                  )}
                <div ref={bottom} />
              </div>
              <div className="composer-wrap">
                <div
                  className={"composer " + (drag ? "dragging" : "")}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    void addFiles(Array.from(e.dataTransfer.files));
                  }}
                >
                  <div className="drafts">
                    {drafts.map((f: any) => (
                      <div className="draft" key={f.id || f.key}>
                        {f.id &&
                        [
                          "image/png",
                          "image/jpeg",
                          "image/webp",
                          "image/gif",
                        ].includes(f.mime) ? (
                          <img
                            className="draft-preview"
                            src={"/api/attachments/" + f.id}
                            alt={f.name}
                          />
                        ) : f.mime?.startsWith("image/") ? (
                          <ImageIcon size={16} />
                        ) : (
                          <FileText size={16} />
                        )}
                        <span>
                          {f.name}
                          <small>
                            {f.error ? (
                              <button onClick={() => retryUpload(f)}>
                                Retry upload
                              </button>
                            ) : !f.id ? (
                              `${f.progress}%`
                            ) : (
                              ""
                            )}
                          </small>
                          {attachmentNotice(f.mime || "", f.name) && (
                            <small className="attachment-notice">
                              {attachmentNotice(f.mime || "", f.name)}
                            </small>
                          )}
                        </span>
                        <button
                          className="icon"
                          aria-label={"Remove " + f.name}
                          disabled={!f.id && !f.error}
                          onClick={() =>
                            run(async () => {
                              if (f.id)
                                await api(
                                  "/attachments/" + f.id,
                                  undefined,
                                  "DELETE",
                                );
                              setDrafts((d) => d.filter((x) => x !== f));
                            })
                          }
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <ComposerInput
                    key={chat.id}
                    chatId={chat.id}
                    commands={chatCommands}
                    provider={chat.provider}
                    value={text}
                    onChange={setText}
                    onFiles={(files) => void addFiles(files)}
                    onSend={() => void send()}
                    onCommand={command}
                    drag={drag}
                    busy={!!busy || sending}
                  />
                  {chat.mode === "plan" && (
                    <div className="plan-banner">
                      <span>
                        Plan mode · review the plan before implementing
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api(`/chats/${chatId}/mode`, {
                              mode: "default",
                            });
                            await loadDetail();
                          })
                        }
                      >
                        Switch to execution
                      </button>
                    </div>
                  )}
                  <div className="composer-actions">
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void addFiles(Array.from(e.target.files || []));
                        e.target.value = "";
                      }}
                    />
                    <button
                      className="icon"
                      aria-label="Attach files"
                      title="Attach files"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={19} />
                    </button>
                    <button
                      className="permission-chip"
                      onClick={() => setModal("chat-settings")}
                    >
                      <ShieldCheck size={14} />
                      {chat.autonomous ? "Autonomous" : "Ask for permission"}
                      <ChevronDown size={12} />
                    </button>
                    <button
                      className="permission-chip model-chip"
                      onClick={() => setModal("chat-model")}
                      title="Model and reasoning effort"
                    >
                      <span>
                        {modelLabel(chat)}
                        {" · " +
                          effortLabel(chat.resolved_effort || chat.effort)}
                      </span>
                      <ChevronDown size={12} />
                    </button>
                    <button
                      className="icon composer-help"
                      aria-label="Commands and help"
                      title="Commands and help"
                      onClick={() => setModal("composer-help")}
                    >
                      <CircleHelp size={18} />
                    </button>
                    <span className="spacer" />
                    {busy ? (
                      <button
                        className="send stop"
                        aria-label="Stop"
                        onClick={() =>
                          run(async () => {
                            await api(`/chats/${chatId}/stop`, {});
                            await loadDetail();
                          })
                        }
                      >
                        <Square size={17} />
                      </button>
                    ) : (
                      <button
                        className="send"
                        aria-label="Send"
                        onClick={send}
                        disabled={
                          sending ||
                          drafts.some((f) => !f.id) ||
                          (!text.trim() && !drafts.length)
                        }
                      >
                        {sending ? (
                          <LoaderCircle className="spin" size={20} />
                        ) : (
                          <ArrowUp size={20} />
                        )}
                      </button>
                    )}
                  </div>
                </div>
                <div className="composer-note">
                  <span>Your agent keeps working while you are offline.</span>
                  <span>Enter to send · Shift + Enter for a new line</span>
                </div>
              </div>
            </section>
            {panel && (
              <aside className="work-panel">
                <header>
                  <strong>
                    {
                      {
                        files: "Chat files",
                        diff: "Code changes",
                        terminal: "Terminal",
                      }[panel]
                    }
                  </strong>
                  <button
                    className="icon"
                    aria-label="Back to chat"
                    onClick={() => setPanel("")}
                  >
                    <span>Back to chat</span>
                    <X size={18} />
                  </button>
                </header>
                {panel === "terminal" ? (
                  <Suspense
                    fallback={<p className="muted">Opening terminal…</p>}
                  >
                    <Terminal chatId={chat.id} />
                  </Suspense>
                ) : (
                  <FilePanel
                    key={chat.id + panel}
                    chatId={chat.id}
                    mode={panel}
                    onError={setError}
                  />
                )}
              </aside>
            )}
          </div>
        )}
      </main>
      {modal === "chat-status" && chat && (
        <Modal error={error} title="Chat status" onClose={() => setModal("")}>
          <p>Agent: {chat.provider === "codex" ? "Codex" : "Claude Code"}</p>
          <p>
            Account:{" "}
            {overview.accounts.find((a: any) => a.id === chat.account_id)?.name}
          </p>
          <p>
            Model: {modelLabel(chat)} ·{" "}
            {effortLabel(chat.resolved_effort || chat.effort)}
          </p>
          <p>
            Mode: {chat.mode === "plan" ? "Plan" : "Execution"} · Status:{" "}
            {job?.state || "Ready"}
          </p>
          <AccountUsage account={account} refresh={loadOverview} />
        </Modal>
      )}
      {modal === "resume-chat" && (
        <Modal error={error} title="Resume a chat" onClose={() => setModal("")}>
          {overview.chats
            .filter((c: any) => c.provider === chat?.provider)
            .map((c: any) => (
              <p key={c.id}>
                <button
                  className="text-button"
                  onClick={() => {
                    selectChat(c.id);
                    setModal("");
                  }}
                >
                  {c.title}
                </button>
              </p>
            ))}
        </Modal>
      )}
      {modal === "composer-help" && (
        <Modal
          error={error}
          title="Commands and references"
          onClose={() => setModal("")}
        >
          {chatCommands.map((c) => (
            <p key={c.name}>
              <strong>/{c.name}</strong> — {c.description}
              {c.unavailable && (
                <small className="muted"> · {c.unavailable}</small>
              )}
            </p>
          ))}
          <p>
            <strong>@</strong> selects a workspace file or connected folder.{" "}
            <strong>$</strong> selects a workspace SKILL.md. References are
            inserted as explicit paths for the agent.
          </p>
          <p className="muted">
            Commands match the selected agent. Some open Workspace controls;
            native actions run through the agent. Claude Code adds commands
            reported by its session after the first message. Unavailable
            commands are listed here for clarity and are not sent as ordinary
            prompts.
          </p>
        </Modal>
      )}
      {modal === "project" && (
        <Modal
          error={error}
          title="Connect a project"
          onClose={() => setModal("")}
        >
          <ConnectProject
            onCreated={async (p: any) => {
              await loadOverview();
              selectProject(p.id);
              setModal("");
            }}
          />
        </Modal>
      )}
      {modal === "project-settings" && editingProject && (
        <Modal
          error={error}
          title="Project settings"
          onClose={() => setModal("")}
        >
          <ProjectSettings
            project={editingProject}
            onSaved={async () => {
              await loadOverview();
              setModal("");
            }}
          />
          <Folders scope="projects" id={editingProject.id} />
        </Modal>
      )}
      {modal === "chat" && (
        <Modal error={error} title="New chat" onClose={() => setModal("")}>
          <NewChat
            overview={overview}
            initialProjectId={newProjectId}
            me={me}
            onError={setError}
            onCreated={async (c: any) => {
              await loadOverview();
              selectChat(c.id);
              setModal("");
            }}
            onSetup={setModal}
          />
        </Modal>
      )}
      {modal === "accounts" && (
        <Modal
          error={error}
          title="Agent accounts"
          onClose={() => {
            setModal("");
            void loadOverview();
          }}
        >
          <Accounts
            accounts={overview.accounts}
            refresh={loadOverview}
            onError={setError}
          />
        </Modal>
      )}
      {modal === "switch" && chat && (
        <Modal
          error={error}
          title="Continue with another account"
          onClose={() => setModal("")}
        >
          <p className="muted">
            Your chat and files stay in place. The new agent receives a summary
            of the previous work. Stop the active task before switching.
          </p>
          {overview.accounts
            .filter((a: any) => a.provider === chat.provider)
            .map((a: any) => (
              <button
                className="account-choice"
                key={a.id}
                disabled={
                  a.status !== "ready" ||
                  ["running", "waiting_approval", "queued"].includes(job?.state)
                }
                onClick={() =>
                  run(async () => {
                    await api(`/chats/${chat.id}/switch`, { account_id: a.id });
                    await loadDetail();
                    setModal("");
                  })
                }
              >
                <span>{a.name}</span>
                <small>{labels[a.status]}</small>
                <ChevronRight size={16} />
              </button>
            ))}
        </Modal>
      )}
      {modal === "delete-chat" && editingChat && (
        <Modal
          error={error}
          title="Delete chat?"
          className="chat-delete-modal"
          onClose={() => {
            if (!chatActionBusy) setModal("");
          }}
        >
          <p>
            Delete <strong>{editingChat.title}</strong> and all its messages,
            attachments and private workspace files? This cannot be undone.
          </p>
          <p className="muted">
            Connected shared folders, your project and published GitHub branches
            are kept. Stop any active task and close its terminal first.
          </p>
          <div className="chat-dialog-actions">
            <button
              className="secondary"
              autoFocus
              disabled={chatActionBusy}
              onClick={() => setModal("")}
            >
              Cancel
            </button>
            <button
              className="danger-button"
              disabled={chatActionBusy}
              onClick={async () => {
                if (chatActionBusy) return;
                setChatActionBusy(true);
                await run(async () => {
                  const result = await api(
                    `/chats/${editingChat.id}`,
                    undefined,
                    "DELETE",
                  );
                  delete textDrafts.current[editingChat.id];
                  setOverview((o: any) => ({
                    ...o,
                    chats: o.chats.filter((c: any) => c.id !== editingChat.id),
                  }));
                  setResults((items) =>
                    items.filter((c) => c.id !== editingChat.id),
                  );
                  if (currentChat.current === editingChat.id) {
                    currentChat.current = null;
                    selectProject(editingChat.project_id || null);
                    setText("");
                    setDrafts([]);
                  }
                  setModal("");
                  if (result.cleanupPending)
                    setTimeout(
                      () =>
                        setError(
                          "Chat deleted, but some private files could not be removed. Check the server logs.",
                        ),
                      0,
                    );
                });
                setChatActionBusy(false);
              }}
            >
              {chatActionBusy ? "Deleting…" : "Delete chat"}
            </button>
          </div>
        </Modal>
      )}
      {modal === "chat-model" && chat && (
        <Modal
          title="Model & thinking"
          className="chat-model-modal"
          error={error}
          onClose={() => setModal("")}
        >
          <ChatModelPicker
            key={chat.id}
            chat={chat}
            onClose={() => setModal("")}
            onError={setError}
            onSave={async (data: any) => {
              await api(`/chats/${chat.id}/model`, data, "PATCH");
              await loadDetail();
              await loadOverview();
              setModal("");
            }}
          />
        </Modal>
      )}
      {modal === "chat-settings" && chat && (
        <Modal error={error} title="Chat settings" onClose={() => setModal("")}>
          <ChatSettings
            chat={chat}
            accounts={overview.accounts}
            me={me}
            onSave={async (data: any) => {
              await api("/chats/" + chat.id, data, "PATCH");
              await loadDetail();
              await loadOverview();
              setModal("");
            }}
            onError={setError}
          />
          <Folders scope="chats" id={chat.id} />
          <hr />
          <button
            className="danger-button"
            onClick={() => {
              setEditingChat(chat);
              setModal("delete-chat");
            }}
          >
            Delete chat…
          </button>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          error={error}
          title="Workspace settings"
          className="settings-modal"
          onClose={() => setModal("")}
        >
          <SettingsForm
            accounts={overview.accounts}
            defaults={overview.modelDefaults}
            onSaved={loadOverview}
            me={me}
            projects={overview.projects}
            onError={setError}
            onAdd={() => setModal("project")}
            onManage={(p: any) => {
              setEditingProject(p);
              setModal("project-settings");
            }}
          />
        </Modal>
      )}
    </div>
  );
}
function Attachment({ file: f }: { file: any }) {
  return (
    <a
      className={"attachment " + (f.mime.startsWith("image/") ? "image" : "")}
      href={"/api/attachments/" + f.id}
      target="_blank"
      rel="noreferrer"
    >
      {["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        f.mime,
      ) ? (
        <img src={"/api/attachments/" + f.id} alt={f.name} />
      ) : (
        <FileText size={20} />
      )}
      <span>
        {f.name}
        <small>{Math.ceil(f.size / 1024)} KB</small>
        {attachmentNotice(f.mime, f.name) && (
          <small className="attachment-notice">
            {attachmentNotice(f.mime, f.name)}
          </small>
        )}
      </span>
      <Download size={14} />
    </a>
  );
}
function NewChat({
  overview,
  initialProjectId,
  onCreated,
  onError,
  onSetup,
}: any) {
  const preferred =
    overview.accounts.find((a: any) => a.status === "ready") ||
    overview.accounts[0];
  const [provider, setProvider] = useState(preferred?.provider || "codex");
  const [accountId, setAccountId] = useState(preferred?.id || "");
  const [creating, setCreating] = useState(false);
  const accounts = overview.accounts.filter(
    (a: any) => a.provider === provider,
  );
  const selectedAccount = accounts.find((a: any) => a.id === accountId);
  const defaults = overview.modelDefaults?.[provider];
  const suggestedModel =
    selectedAccount?.model_catalog?.find((m: any) => m.isDefault) ||
    selectedAccount?.model_catalog?.[0];
  function selectProvider(next: string) {
    setProvider(next);
    setAccountId(
      overview.accounts.find(
        (a: any) => a.provider === next && a.status === "ready",
      )?.id ||
        overview.accounts.find((a: any) => a.provider === next)?.id ||
        "",
    );
  }
  if (!overview.accounts.length)
    return (
      <div className="setup-empty">
        <p>Connect your Codex or Claude Code account to start chatting.</p>
        <button className="primary" onClick={() => onSetup("accounts")}>
          Connect an agent account
        </button>
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (creating || !accountId) return;
        setCreating(true);
        const f = new FormData(e.currentTarget);
        try {
          const c = await api("/chats", {
            project_id: f.get("project") || null,
            provider,
            account_id: accountId,
            model: f.get("model") || "",
            effort: f.get("effort") || "",
            autonomous: f.get("autonomous") === "on",
          });
          await onCreated(c);
        } catch (e: any) {
          onError(e.message);
        } finally {
          setCreating(false);
        }
      }}
    >
      <fieldset className="form-fields" disabled={creating}>
        <Field label="Project">
          <Select
            aria-label="Project"
            name="project"
            defaultValue={initialProjectId || ""}
          >
            <option value="">Personal chat</option>
            {overview.projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className="muted">
          Project chats use the project’s repository and folders.
        </p>
        <div className="segmented" role="group" aria-label="Choose your agent">
          <button
            type="button"
            aria-pressed={provider === "codex"}
            className={provider === "codex" ? "selected" : ""}
            onClick={() => selectProvider("codex")}
          >
            ◈ Codex
          </button>
          <button
            type="button"
            aria-pressed={provider === "claude"}
            className={provider === "claude" ? "selected" : ""}
            onClick={() => selectProvider("claude")}
          >
            ✳ Claude Code
          </button>
        </div>
        {accounts.length ? (
          <Field label="Account">
            <Select
              aria-label="Account"
              name="account"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              {accounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {labels[a.status] || a.status}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <div className="setup-empty">
            <p>
              Add a {provider === "codex" ? "Codex" : "Claude Code"} account to
              use this agent.
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => onSetup("accounts")}
            >
              Open agent accounts
            </button>
          </div>
        )}
        {selectedAccount && selectedAccount.status !== "ready" && (
          <p className="muted">
            You can create this chat now. Connect the account in Agent accounts
            before sending a task.
          </p>
        )}
        <p className="new-chat-model">
          Starting model from settings:{" "}
          <strong>
            {defaults?.model ||
              suggestedModel?.model ||
              suggestedModel?.id ||
              (provider === "claude" ? "Sonnet" : "Choose a model below")}
          </strong>
          {defaults?.effort || suggestedModel?.defaultReasoningEffort
            ? " · " +
              effortLabel(
                defaults?.effort || suggestedModel?.defaultReasoningEffort,
              )
            : ""}
          {defaults && (
            <small>
              From Settings → Models. You can change it below or later in the
              chat.
            </small>
          )}
        </p>
        <details className="advanced-options">
          <summary>Change model and permissions</summary>
          <ModelOptions
            key={
              provider +
              accountId +
              (defaults?.model || "") +
              (defaults?.effort || "")
            }
            provider={provider}
            accountId={accountId}
            initialModel={defaults?.model || ""}
            initialEffort={defaults?.effort || ""}
          />
          <label className="checkbox">
            <input name="autonomous" type="checkbox" />
            Run without approval prompts
          </label>
          <p className="muted">
            Allow the agent to run commands and edit files without asking for
            approval.
          </p>
        </details>
        <p className="muted">
          Your first message names the chat. You can rename it in Chat settings.
        </p>
        <button
          className="primary form-submit"
          disabled={!accountId || creating}
        >
          <Plus size={17} />
          {creating ? "Creating chat…" : "Create chat"}
        </button>
      </fieldset>
    </form>
  );
}
function Accounts({ accounts, refresh, onError }: any) {
  const [provider, setProvider] = useState("codex"),
    [authId, setAuthId] = useState(""),
    [events, setEvents] = useState<any[]>([]),
    [authInput, setAuthInput] = useState(""),
    [copiedCode, setCopiedCode] = useState(""),
    [copyError, setCopyError] = useState(""),
    [connecting, setConnecting] = useState(false),
    [disconnecting, setDisconnecting] = useState(""),
    [adding, setAdding] = useState(false),
    [added, setAdded] = useState("");
  useEffect(() => {
    if (!authId) return;
    const t = setInterval(() => {
      api("/accounts/" + authId + "/auth")
        .then((r) => {
          setEvents(r.events);
          if (
            r.events.some((e: any) =>
              ["auth_complete", "failed", "exit"].includes(e.type),
            )
          )
            void refresh();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [authId]);
  async function start(id: string) {
    if (connecting) return;
    setConnecting(true);
    setCopiedCode("");
    setCopyError("");
    try {
      await api("/accounts/" + id + "/auth", undefined, "DELETE");
      await api("/accounts/" + id + "/auth", {});
      setEvents([]);
      setAuthId(id);
      await refresh();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setConnecting(false);
    }
  }
  const authText = cleanTerminalText(
    events
      .filter((e) => ["auth_output", "log", "failed"].includes(e.type))
      .map((e) => e.text || e.error)
      .join(""),
  );
  const claudeUrl = claudeSignInUrl(authText);
  return (
    <>
      <p className="accounts-intro">
        Add an account below, then select Connect to sign in with Codex or
        Claude Code. You can connect multiple accounts.
      </p>
      <form
        className="account-add-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (adding) return;
          const form = e.currentTarget;
          const name = String(new FormData(form).get("name") || "").trim();
          if (!name) return;
          setAdding(true);
          setAdded("");
          try {
            await api("/accounts", { name, provider });
            form.reset();
            setAdded(`${name} added. Select Connect below to sign in.`);
            await refresh();
          } catch (e: any) {
            onError(e.message);
          } finally {
            setAdding(false);
          }
        }}
      >
        <h3>
          {accounts.length ? "Add another account" : "Add your first account"}
        </h3>
        <div className="form-row">
          <Field label="Account label">
            <input
              name="name"
              required
              maxLength={80}
              placeholder="e.g. Personal, Work, Account 3"
            />
          </Field>
          <Field label="Service">
            <Select
              aria-label="Service"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </Select>
          </Field>
        </div>
        <button className="primary" disabled={adding}>
          <Plus size={17} />
          {adding ? "Adding account…" : "Add account"}
        </button>
        {added && (
          <p className="account-added" role="status">
            {added}
          </p>
        )}
      </form>
      <div className="accounts-summary">
        <h3>Your accounts</h3>
        <span>
          {accounts.length} added ·{" "}
          {accounts.filter((a: any) => a.status === "ready").length} connected
        </span>
      </div>
      <div className="account-list">
        {[
          { id: "codex", name: "Codex" },
          { id: "claude", name: "Claude Code" },
        ].map((service) => (
          <section
            className="account-group"
            key={service.id}
            aria-label={service.name + " accounts"}
          >
            <header>
              <strong>{service.name}</strong>
              <span>
                {accounts.filter((a: any) => a.provider === service.id).length}{" "}
                saved
              </span>
            </header>
            {!accounts.some((a: any) => a.provider === service.id) && (
              <p className="muted">
                No accounts added yet. Add your first {service.name} account
                above.
              </p>
            )}
            {accounts
              .filter((a: any) => a.provider === service.id)
              .map((a: any) => (
                <div className="account-row" key={a.id}>
                  <span className={"provider-icon " + a.provider}>
                    {a.provider === "codex" ? "◈" : "✳"}
                  </span>
                  <div>
                    <strong>{a.name}</strong>
                    <small>
                      <span className={"status-dot " + a.status} />
                      {labels[a.status]}
                    </small>
                    <AccountUsage account={a} refresh={refresh} />
                  </div>
                  {["ready", "limited", "disconnect_failed"].includes(
                    a.status,
                  ) ? (
                    <button
                      className="secondary"
                      disabled={!!disconnecting || connecting}
                      onClick={async () => {
                        setDisconnecting(a.id);
                        try {
                          await api("/accounts/" + a.id + "/logout", {});
                          if (authId === a.id) {
                            setAuthId("");
                            setEvents([]);
                          }
                        } catch (e: any) {
                          onError(e.message);
                        } finally {
                          setDisconnecting("");
                          await refresh();
                        }
                      }}
                    >
                      {disconnecting === a.id
                        ? "Disconnecting…"
                        : a.status === "disconnect_failed"
                          ? "Retry disconnect"
                          : "Disconnect"}
                    </button>
                  ) : (
                    <button
                      className="secondary"
                      disabled={
                        connecting ||
                        !!disconnecting ||
                        a.status === "disconnecting" ||
                        a.status === "inspecting"
                      }
                      onClick={() => start(a.id)}
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
          </section>
        ))}
      </div>
      <p className="accounts-footnote">
        You can save any number of accounts. Set parallel task capacity in
        Settings → Resources. One task runs per account.
      </p>
      {authId && (
        <div className="auth-flow">
          <strong>Sign in through the official agent</strong>
          {!claudeUrl &&
            !events.some((e) =>
              ["auth_url", "auth_complete", "failed"].includes(e.type),
            ) && <p className="muted">Waiting for the sign-in link…</p>}
          {claudeUrl && (
            <a href={claudeUrl} target="_blank" rel="noreferrer">
              Open Claude sign-in <ExternalLink size={14} />
            </a>
          )}
          {events
            .filter((e) => e.type === "auth_url")
            .map((e, i) => (
              <div key={i}>
                <a target="_blank" rel="noreferrer" href={e.verificationUrl}>
                  Open sign-in page <ExternalLink size={14} />
                </a>
                <div className="device-code-row">
                  <code className="device-code">{e.userCode}</code>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Copy device code"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(e.userCode);
                        setCopiedCode(e.userCode);
                        setCopyError("");
                      } catch {
                        setCopyError(
                          "Unable to copy automatically. Select the code and copy it manually.",
                        );
                      }
                    }}
                  >
                    {copiedCode === e.userCode ? (
                      <Check size={16} />
                    ) : (
                      <Copy size={16} />
                    )}
                    <span role="status">
                      {copiedCode === e.userCode ? "Copied" : "Copy code"}
                    </span>
                  </button>
                </div>
              </div>
            ))}
          <pre>{authText}</pre>
          {copyError && (
            <p className="inline-error" role="alert">
              {copyError}
            </p>
          )}
          {events.some((e) => e.type === "auth_complete" && e.success) ? (
            <p className="success">
              <Check size={17} />
              Account connected
            </p>
          ) : accounts.find((a: any) => a.id === authId)?.provider ===
            "claude" ? (
            <>
              <Field label="Browser code (only if requested during sign-in)">
                <input
                  value={authInput}
                  onChange={(e) => setAuthInput(e.target.value)}
                />
              </Field>
              <button
                className="secondary"
                onClick={async () => {
                  try {
                    await api("/accounts/" + authId + "/auth-input", {
                      data: authInput,
                    });
                    setAuthInput("");
                  } catch (e: any) {
                    onError(e.message);
                  }
                }}
              >
                Submit code
              </button>
            </>
          ) : null}
          <button
            className="text-button"
            disabled={connecting}
            onClick={async () => {
              setConnecting(true);
              try {
                await api("/accounts/" + authId + "/auth", undefined, "DELETE");
                setAuthId("");
                setEvents([]);
                await refresh();
              } catch (e: any) {
                onError(e.message);
              } finally {
                setConnecting(false);
              }
            }}
          >
            Close sign-in
          </button>
        </div>
      )}
    </>
  );
}
function ChatSettings({ chat, me, onSave, onError }: any) {
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        const f = new FormData(e.currentTarget);
        try {
          await onSave({
            title: f.get("title"),
            model: f.get("model"),
            effort: f.get("effort"),
            autonomous: f.get("autonomous") === "on",
            handoff: f.get("handoff"),
          });
        } catch (e: any) {
          onError(e.message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <Field label="Chat name">
        <input
          name="title"
          defaultValue={chat.title}
          maxLength={160}
          required
        />
      </Field>
      <ModelOptions
        provider={chat.provider}
        accountId={chat.account_id}
        initialModel={chat.model}
        initialEffort={chat.effort}
      />
      <Field label="Account switching">
        <Select
          aria-label="Account switching"
          name="handoff"
          defaultValue={chat.handoff}
        >
          <option value="manual">Choose manually</option>
          <option value="auto" disabled={!me.autoHandoff}>
            Automatically
            {!me.autoHandoff ? "  — requires verification and activation" : ""}
          </option>
        </Select>
      </Field>
      <label className="checkbox">
        <input
          name="autonomous"
          type="checkbox"
          defaultChecked={chat.autonomous}
        />
        Run without approval prompts
      </label>
      <p className="muted">
        Allow the agent to run commands and edit files in this workspace without
        asking. Leave off to review permission requests.
      </p>
      <button className="primary" disabled={saving}>
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
function FilePanel({ chatId, mode, onError }: any) {
  const [files, setFiles] = useState<any[]>([]),
    [dir, setDir] = useState(""),
    [diff, setDiff] = useState(""),
    [view, setView] = useState<any>(null),
    [message, setMessage] = useState(""),
    [result, setResult] = useState(""),
    [loading, setLoading] = useState(true),
    [publishing, setPublishing] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    (mode === "files"
      ? api(`/chats/${chatId}/files?path=${encodeURIComponent(dir)}`).then(
          (items) => {
            if (live) setFiles(items);
          },
        )
      : api(`/chats/${chatId}/diff`).then((r) => {
          if (live) setDiff(r.diff);
        })
    )
      .catch((e: any) => {
        if (live) onError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [chatId, mode, dir]);
  async function publish(action: string) {
    if (publishing) return;
    setPublishing(true);
    setResult("");
    try {
      const r = await api(`/chats/${chatId}/git`, {
        action,
        message,
        client_id: crypto.randomUUID(),
      });
      setResult(r.html_url || r.output || r.status || "Done");
      const updated = await api(`/chats/${chatId}/diff`);
      setDiff(updated.diff);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setPublishing(false);
    }
  }
  return (
    <div className="panel-content">
      {loading && (
        <p className="muted" role="status">
          Loading {mode === "files" ? "files" : "changes"}…
        </p>
      )}
      {mode === "files" ? (
        <>
          <button
            className="text-button"
            onClick={() => {
              setDir(dir.split("/").slice(0, -1).join("/"));
              setView(null);
            }}
          >
            {dir ? "← Parent folder · /" + dir : "Workspace files"}
          </button>
          {!loading && !files.length && (
            <p className="muted">
              This folder is empty. Files appear as your agent works.
            </p>
          )}
          {files.map((f) => (
            <button
              className="file-row"
              key={f.path}
              onClick={() => {
                if (f.directory) {
                  setDir(f.path);
                  setView(null);
                } else {
                  void fetch(
                    `/api/chats/${chatId}/file?path=${encodeURIComponent(f.path)}`,
                  )
                    .then(async (r) => {
                      if (!r.ok) throw new Error("Unable to open this file");
                      const blob = await r.blob();
                      setView({
                        path: f.path,
                        text:
                          blob.size < 200000
                            ? await blob.text()
                            : "This file is too large to preview. Download it instead.",
                      });
                    })
                    .catch((e) => onError(e.message));
                }
              }}
            >
              {f.directory ? <FolderGit2 size={16} /> : <FileText size={16} />}
              <span>{f.name}</span>
            </button>
          ))}
          {view && (
            <div className="file-preview">
              <a
                href={`/api/chats/${chatId}/file?path=${encodeURIComponent(view.path)}`}
              >
                <Download size={14} /> Download
              </a>
              <pre>{view.text}</pre>
            </div>
          )}
        </>
      ) : (
        <>
          <pre className="diff">
            {diff || "No tracked changes. New files appear after a commit."}
          </pre>
          <Field label="Commit message / pull request title">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe the changes"
            />
          </Field>
          <div className="button-row">
            <button
              className="secondary"
              disabled={!message.trim() || publishing || loading}
              onClick={() => publish("commit")}
            >
              Commit
            </button>
            <button
              className="secondary"
              disabled={!message.trim() || publishing || loading}
              onClick={() => publish("push")}
            >
              Push
            </button>
            <button
              className="primary"
              disabled={!message.trim() || publishing || loading}
              onClick={() => publish("pr")}
            >
              Create pull request
            </button>
          </div>
          <p className="muted">
            Push and pull requests run only when you select the corresponding
            action.
          </p>
          {publishing && <p role="status">Publishing changes…</p>}
          {result && (
            <p className="operation-result">
              {result.startsWith("https://github.com/") ? (
                <a href={result} target="_blank" rel="noreferrer">
                  Open PR ↗
                </a>
              ) : (
                result
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
function SettingsForm({
  me,
  projects,
  accounts,
  defaults,
  onSaved,
  onError,
  onAdd,
  onManage,
}: any) {
  const [saved, setSaved] = useState(false),
    [section, setSection] = useState("models");
  async function push() {
    try {
      if (!me.vapidKey)
        throw new Error("Web Push is not configured on this server yet");
      if (!("PushManager" in window))
        throw new Error(
          "Install the app on your home screen or use a browser that supports Web Push",
        );
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error("Notifications are not allowed");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: me.vapidKey,
      });
      await api("/push", sub.toJSON());
      setSaved(true);
    } catch (e: any) {
      onError(e.message);
    }
  }
  return (
    <>
      <div
        className="segmented settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {[
          { id: "models", label: "Models" },
          { id: "connections", label: "Connections" },
          { id: "resources", label: "Resources" },
          { id: "notifications", label: "Notifications" },
        ].map((item) => (
          <button
            key={item.id}
            id={"settings-tab-" + item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            aria-controls={"settings-panel-" + item.id}
            className={section === item.id ? "selected" : ""}
            onClick={() => {
              setSection(item.id);
              setSaved(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === "models" && (
        <div
          role="tabpanel"
          id="settings-panel-models"
          aria-labelledby="settings-tab-models"
        >
          <ModelDefaults
            accounts={accounts}
            defaults={defaults}
            onSaved={onSaved}
          />
        </div>
      )}
      {section === "resources" && (
        <div
          role="tabpanel"
          id="settings-panel-resources"
          aria-labelledby="settings-tab-resources"
        >
          <ServerSettings />
        </div>
      )}
      {section === "connections" && (
        <div
          role="tabpanel"
          id="settings-panel-connections"
          aria-labelledby="settings-tab-connections"
        >
          <h3>Projects</h3>
          <p className="muted">
            Each project has its own GitHub token. Chats can also run without a
            repository.
          </p>
          <div className="project-settings-list">
            {projects.map((p: any) => (
              <button
                key={p.id}
                className="project-settings-row"
                onClick={() => onManage(p)}
              >
                <FolderGit2 size={18} />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.repo} ·{" "}
                    {p.github_configured ? "Token saved" : "No token"}
                  </small>
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          <button className="primary" onClick={onAdd}>
            <Plus size={16} />
            Connect a project
          </button>
        </div>
      )}
      {section === "notifications" && (
        <div
          role="tabpanel"
          id="settings-panel-notifications"
          aria-labelledby="settings-tab-notifications"
        >
          <h3>Notifications</h3>
          <p className="muted">
            Get notified when a task finishes or your agent needs permission.
          </p>
          <button className="secondary" onClick={push}>
            <Bell size={16} />
            Enable on this device
          </button>
        </div>
      )}
      {saved && (
        <p className="success">
          <Check size={16} />
          Saved
        </p>
      )}
    </>
  );
}

function ConnectProject({
  onCreated,
}: {
  onCreated: (project: any) => Promise<void>;
}) {
  const [repository, setRepository] = useState("");
  const [projectTokenInput, setProjectTokenInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const normalized = normalizeGithubRepo(repository);
  return (
    <>
      <p className="muted">
        Paste a GitHub repository link or enter owner/repository. Access is
        configured for this project only.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (!normalized) {
            setError("Enter owner/repository or a GitHub repository URL.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const created = await api("/projects", {
              repo: repository,
              ...(projectTokenInput.trim()
                ? { token: projectTokenInput.trim() }
                : {}),
            });
            await onCreated(created);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Repository">
          <input
            required
            value={repository}
            onChange={(e) => {
              setRepository(e.target.value);
              setError("");
            }}
            placeholder="https://github.com/owner/repository"
            maxLength={2048}
            aria-describedby="repository-help"
            aria-invalid={!!error}
          />
        </Field>
        <p className="muted" id="repository-help">
          {normalized
            ? "Repository: " + normalized
            : "Also accepts owner/repository"}
        </p>
        <Field label="Access token (optional)">
          <input
            type="password"
            autoComplete="new-password"
            value={projectTokenInput}
            onChange={(e) => setProjectTokenInput(e.target.value)}
            placeholder="github_pat_…"
            minLength={10}
            maxLength={500}
          />
        </Field>
        <GithubTokenHelp />
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          <FolderGit2 size={17} />
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </>
  );
}
