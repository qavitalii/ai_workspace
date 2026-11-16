import { ComposerInput, chatCommands } from "./ComposerInput";
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
  Search,
  FolderGit2,
  MessageSquare,
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
  Command,
  Activity,
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
}: {
  className?: string;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal " + className}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
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
              placeholder="000 000"
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
        <small>Private access · password + TOTP</small>
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
    [detail, setDetail] = useState<any>(null),
    [modal, setModal] = useState(""),
    [editingProject, setEditingProject] = useState<any>(null),
    [error, setError] = useState(""),
    [mobile, setMobile] = useState(false),
    [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
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
    currentChat = useRef(chatId);
  currentChat.current = chatId;
  const loadOverview = () => api("/overview").then(setOverview);
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
    setText("");
    setDrafts([]);
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
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
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
        if (["status", "approval", "handoff"].includes(ev.type)) {
          void loadDetail(chatId);
          void loadOverview();
        }
      };
      ws.onclose = () => {
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
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [detail?.messages.length, streams]);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(
      () =>
        api("/search?q=" + encodeURIComponent(query))
          .then(setResults)
          .catch(() => {}),
      250,
    );
    return () => clearTimeout(t);
  }, [query]);
  const run = async (fn: () => Promise<any>) => {
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };
  function selectChat(id: string) {
    setChatId(id);
    setMobile(false);
    history.replaceState(null, "", "?chat=" + id);
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
  function command(name: string) {
    if (name === "new") setModal("chat");
    if (name === "model" || name === "settings") setModal("chat-settings");
    if (name === "files" || name === "terminal") setPanel(name);
    if (name === "stop" && chatId)
      void run(async () => {
        await api(`/chats/${chatId}/stop`, {});
        await loadDetail();
      });
    if (name === "help") setModal("composer-help");
  }
  async function send() {
    const shortcut = text.trim().match(/^\/([a-z]+)$/);
    if (shortcut && chatCommands.some((c) => c.name === shortcut[1])) {
      command(shortcut[1]);
      setText("");
      return;
    }

    if (
      !chatId ||
      sending ||
      drafts.some((f) => !f.id) ||
      (!text.trim() && !drafts.length)
    )
      return;
    setSending(true);
    try {
      await api(`/chats/${chatId}/messages`, {
        content: text,
        client_id: clientId.current,
        attachment_ids: drafts.map((f) => f.id),
      });
      clientId.current = crypto.randomUUID();
      setText("");
      setDrafts([]);
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
    project = overview.projects.find((p: any) => p.id === chat?.project_id),
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
      <aside className={"sidebar " + (mobile ? "open" : "")}>
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
        <button className="new-chat" onClick={() => setModal("chat")}>
          <Plus size={18} />
          New chat<span>⌘ N</span>
        </button>
        <div className="search">
          <Search size={16} />
          <input
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sidebar-section">
          <span>PROJECTS</span>
          <button
            className="icon"
            aria-label="Add project"
            onClick={() => setModal("project")}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav>
          {overview.projects.map((p: any) => (
            <div key={p.id} className="project-nav">
              <FolderGit2 size={17} />
              <span>{p.name}</span>
              <span className="muted">
                {
                  overview.chats.filter((c: any) => c.project_id === p.id)
                    .length
                }
              </span>
              <button
                className="icon"
                aria-label={"Project settings: " + p.name}
                title="Project settings"
                onClick={() => {
                  setEditingProject(p);
                  setModal("project-settings");
                }}
              >
                <Settings size={14} />
              </button>
            </div>
          ))}
          {!overview.projects.length && (
            <button className="empty-link" onClick={() => setModal("project")}>
              Connect a GitHub project <Plus size={14} />
            </button>
          )}
        </nav>
        <div className="sidebar-section">
          <span>{query ? "RESULTS" : "RECENT CHATS"}</span>
        </div>
        <nav className="chat-nav">
          {(query ? results : overview.chats).map((c: any, i: number) => (
            <button
              key={c.id + "-" + i}
              className={chatId === c.id ? "selected" : ""}
              onClick={() => selectChat(c.id)}
            >
              <MessageSquare size={16} />
              <span>{c.title}</span>
              {c.state === "running" && <span className="dot" />}
            </button>
          ))}
          {!overview.chats.length && (
            <p className="side-hint">
              Your conversations with agents will appear here.
            </p>
          )}
        </nav>
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
      <main className="main">
        <header className="topbar">
          <button
            className="icon mobile-only"
            aria-label="Open menu"
            onClick={() => setMobile(true)}
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumb">
            <span>{project?.name || "Personal workspace"}</span>
            <ChevronRight size={14} />
            <strong>{chat?.title || "Overview"}</strong>
          </div>
          <div className="top-actions">
            {chat && (
              <>
                <span className={"connection " + (connected ? "online" : "")}>
                  {connected ? "Live" : "Connecting…"}
                </span>
                <button
                  className={"icon " + (panel === "files" ? "active" : "")}
                  title="Files"
                  aria-label="Files"
                  onClick={() => setPanel(panel === "files" ? "" : "files")}
                >
                  <Files size={18} />
                </button>
                {chat.project_id && (
                  <button
                    className={"icon " + (panel === "diff" ? "active" : "")}
                    title="Changes"
                    aria-label="Changes"
                    onClick={() => setPanel(panel === "diff" ? "" : "diff")}
                  >
                    <GitBranch size={18} />
                  </button>
                )}
                <button
                  className={"icon " + (panel === "terminal" ? "active" : "")}
                  title="Terminal"
                  aria-label="Terminal"
                  onClick={() =>
                    setPanel(panel === "terminal" ? "" : "terminal")
                  }
                >
                  <TerminalIcon size={18} />
                </button>
              </>
            )}
          </div>
        </header>
        {error && (
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
        {!chat ? (
          <div className="welcome">
            <div className="eyebrow">
              <span className="dot" /> ALWAYS ON, READY WHEN YOU ARE
            </div>
            <div className="welcome-symbol">
              <Command size={34} />
            </div>
            <h1>
              Your ideas.
              <br />
              <span>Agents at work.</span>
            </h1>
            <p>
              One home for Codex and Claude Code.
              <br />
              Start on your computer. Pick up from your phone.
            </p>
            <button className="primary" onClick={() => setModal("chat")}>
              <Plus size={18} />
              Start a new chat
            </button>
            <div className="welcome-cards">
              <button onClick={() => setModal("project")}>
                <FolderGit2 />
                <strong>Connect a project</strong>
                <span>Repositories and separate task branches</span>
                <ChevronRight size={16} />
              </button>
              <button onClick={() => setModal("accounts")}>
                <ArrowRightLeft />
                <strong>Add your accounts</strong>
                <span>Codex and Claude Code, together</span>
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="welcome-footer">
              <ShieldCheck size={15} />
              Your server. Your files. Your control.
            </div>
          </div>
        ) : (
          <div className={"workspace " + (panel ? "with-panel" : "")}>
            <section className="conversation">
              <div className="chat-meta">
                <span className={"provider " + chat.provider}>
                  {chat.provider === "codex" ? "◈ Codex" : "✳ Claude Code"}
                </span>
                <button onClick={() => setModal("chat-settings")}>
                  {chat.model || "Default model"}
                  <ChevronDown size={13} />
                </button>
                <span className="meta-separator" />
                <button onClick={() => setModal("switch")}>
                  {account?.name || "Account"}
                  <ArrowRightLeft size={13} />
                </button>
                <span className="chat-mode">
                  {chat.autonomous ? "Autonomous" : "With approvals"}
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
              <div className="messages">
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
                        : "Your files stay in this chat’s own workspace. No Git repository required."}
                    </p>
                    <span className="branch-label">
                      <GitBranch size={14} />
                      {chat.project_id ? chat.branch : "Private workspace"}
                    </span>
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
                {detail.approvals.map((a: any) => (
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
                              await api("/approvals/" + a.id, { allow: true });
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
                              await api("/approvals/" + a.id, { allow: false });
                              await loadDetail();
                            })
                          }
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
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
                    value={text}
                    onChange={setText}
                    onFiles={(files) => void addFiles(files)}
                    onSend={() => void send()}
                    onCommand={command}
                    drag={drag}
                  />
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
                      className="permission-chip"
                      onClick={() => setModal("chat-settings")}
                      title="Model and reasoning effort"
                    >
                      {chat.model || "Default model"} ·{" "}
                      {chat.effort || "Default effort"}
                      <ChevronDown size={12} />
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
                  <span>⌘ / Ctrl + Enter</span>
                </div>
              </div>
            </section>
            {panel && (
              <aside className="work-panel">
                <header>
                  <strong>
                    {
                      {
                        files: "Project files",
                        diff: "Code changes",
                        terminal: "Terminal",
                      }[panel]
                    }
                  </strong>
                  <button
                    className="icon"
                    aria-label="Close panel"
                    onClick={() => setPanel("")}
                  >
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
      {modal === "composer-help" && (
        <Modal title="Commands and references" onClose={() => setModal("")}>
          {chatCommands.map((c) => (
            <p key={c.name}>
              <strong>/{c.name}</strong> — {c.description}
            </p>
          ))}
          <p>
            <strong>@</strong> selects a workspace file or connected folder.{" "}
            <strong>$</strong> selects a workspace SKILL.md. References are
            inserted as explicit paths for the agent.
          </p>
          <p className="muted">
            These are Workspace commands. Native CLI slash commands,
            account-wide skills and app mentions are not automatically available
            in this integration.
          </p>
        </Modal>
      )}
      {modal === "project" && (
        <Modal title="Connect a project" onClose={() => setModal("")}>
          <ConnectProject
            onCreated={async () => {
              await loadOverview();
              setModal("");
            }}
          />
        </Modal>
      )}
      {modal === "project-settings" && editingProject && (
        <Modal title="Project settings" onClose={() => setModal("")}>
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
        <Modal title="New chat" onClose={() => setModal("")}>
          <NewChat
            overview={overview}
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
      {modal === "chat-settings" && chat && (
        <Modal title="Chat settings" onClose={() => setModal("")}>
          <ChatSettings
            chat={chat}
            accounts={overview.accounts}
            me={me}
            onSave={async (data: any) => {
              await api("/chats/" + chat.id, data, "PATCH");
              await loadDetail();
              setModal("");
            }}
            onError={setError}
          />
          <Folders scope="chats" id={chat.id} />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          title="Workspace settings"
          className="settings-modal"
          onClose={() => setModal("")}
        >
          <SettingsForm
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
function NewChat({ overview, me, onCreated, onError, onSetup }: any) {
  const [provider, setProvider] = useState("codex");
  const [accountId, setAccountId] = useState(
    overview.accounts.find((a: any) => a.provider === "codex")?.id || "",
  );
  useEffect(
    () =>
      setAccountId(
        overview.accounts.find((a: any) => a.provider === provider)?.id || "",
      ),
    [provider],
  );
  if (!overview.accounts.length)
    return (
      <div className="setup-empty">
        <p>
          Connect an agent account to start your first chat. GitHub is optional.
        </p>
        <button className="primary" onClick={() => onSetup("accounts")}>
          Set up
        </button>
      </div>
    );
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          const c = await api("/chats", {
            project_id: f.get("project") || null,
            provider,
            account_id: f.get("account"),
            model: f.get("model"),
            effort: f.get("effort"),
            autonomous: f.get("autonomous") === "on",
          });
          await onCreated(c);
        } catch (e: any) {
          onError(e.message);
        }
      }}
    >
      <Field label="Project (optional)">
        <select name="project" defaultValue="">
          <option value="">No repository — private workspace</option>
          {overview.projects.map((p: any) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="segmented">
        <button
          type="button"
          className={provider === "codex" ? "selected" : ""}
          onClick={() => setProvider("codex")}
        >
          ◈ Codex
        </button>
        <button
          type="button"
          className={provider === "claude" ? "selected" : ""}
          onClick={() => setProvider("claude")}
        >
          ✳ Claude Code
        </button>
      </div>
      <Field label="Account">
        <select
          name="account"
          required
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          {overview.accounts
            .filter((a: any) => a.provider === provider)
            .map((a: any) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status !== "ready" ? " · " + labels[a.status] : ""}
              </option>
            ))}
        </select>
      </Field>
      <ModelOptions provider={provider} accountId={accountId} />
      <label className="checkbox">
        <input name="autonomous" type="checkbox" />
        Run without approval prompts
      </label>
      <p className="muted">
        Allow the agent to run commands and edit files in this workspace without
        asking. Leave off to review permission requests.
      </p>
      <button className="primary">
        <Plus size={17} />
        Create chat
      </button>
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
        Add as many accounts as you need, including multiple accounts for the
        same service. Each account has its own sign-in and usage limits.
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
        <h3>Add another account</h3>
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
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
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
                    {a.limits && (
                      <small>
                        {a.limits.usedPercent !== undefined
                          ? `${a.limits.usedPercent}% used`
                          : "Usage information received"}
                      </small>
                    )}
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
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
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
        }
      }}
    >
      <Field label="Name">
        <input name="title" defaultValue={chat.title} required />
      </Field>
      <ModelOptions
        provider={chat.provider}
        accountId={chat.account_id}
        initialModel={chat.model}
        initialEffort={chat.effort}
      />
      <Field label="Account switching">
        <select name="handoff" defaultValue={chat.handoff}>
          <option value="manual">Choose manually</option>
          <option value="auto" disabled={!me.autoHandoff}>
            Automatically
            {!me.autoHandoff ? "  — requires verification and activation" : ""}
          </option>
        </select>
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
      <button className="primary">Save</button>
    </form>
  );
}
function FilePanel({ chatId, mode, onError }: any) {
  const [files, setFiles] = useState<any[]>([]),
    [dir, setDir] = useState(""),
    [diff, setDiff] = useState(""),
    [view, setView] = useState<any>(null),
    [message, setMessage] = useState(""),
    [result, setResult] = useState("");
  useEffect(() => {
    (mode === "files"
      ? api(`/chats/${chatId}/files?path=${encodeURIComponent(dir)}`).then(
          setFiles,
        )
      : api(`/chats/${chatId}/diff`).then((r) => setDiff(r.diff))
    ).catch((e: any) => onError(e.message));
  }, [chatId, mode, dir]);
  async function publish(action: string) {
    try {
      const r = await api(`/chats/${chatId}/git`, {
        action,
        message,
        client_id: crypto.randomUUID(),
      });
      setResult(r.html_url || r.output || r.status || "Done");
    } catch (e: any) {
      onError(e.message);
    }
  }
  return (
    <div className="panel-content">
      {mode === "files" ? (
        <>
          <button
            className="text-button"
            onClick={() => {
              setDir(dir.split("/").slice(0, -1).join("/"));
              setView(null);
            }}
          >
            ← /{dir}
          </button>
          {files.map((f) => (
            <button
              className="file-row"
              key={f.path}
              onClick={async () => {
                if (f.directory) {
                  setDir(f.path);
                  setView(null);
                } else {
                  const r = await fetch(
                    `/api/chats/${chatId}/file?path=${encodeURIComponent(f.path)}`,
                  );
                  if (!r.ok) {
                    onError("Unable to open this file");
                    return;
                  }
                  const blob = await r.blob();
                  setView({
                    path: f.path,
                    text:
                      blob.size < 200000
                        ? await blob.text()
                        : "This file is too large to preview. Download it instead.",
                  });
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
              disabled={!message}
              onClick={() => publish("commit")}
            >
              Commit
            </button>
            <button
              className="secondary"
              disabled={!message}
              onClick={() => publish("push")}
            >
              Push
            </button>
            <button
              className="primary"
              disabled={!message}
              onClick={() => publish("pr")}
            >
              Create PR
            </button>
          </div>
          <p className="muted">
            Push and pull requests run only when you select the corresponding
            action.
          </p>
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
function SettingsForm({ me, projects, onError, onAdd, onManage }: any) {
  const [saved, setSaved] = useState(false),
    [section, setSection] = useState("connections");
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

function ConnectProject({ onCreated }: { onCreated: () => Promise<void> }) {
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
            await api("/projects", {
              repo: repository,
              ...(projectTokenInput.trim()
                ? { token: projectTokenInput.trim() }
                : {}),
            });
            await onCreated();
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
        <p className="muted">
          Needed for private repositories and publishing. Select this repository
          in your token; allow Contents and Pull requests: read/write for
          publishing.
        </p>
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
