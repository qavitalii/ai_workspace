import { ChangesPanel } from "./ChangesPanel";
import { AccountSwitcher } from "./AccountSwitcher";
import { ActivityLog } from "./ActivityLog";
import { recentActivityEvents, type ActivityEvent } from "./activity-log";
import { ChatMarkdown } from "./ChatMarkdown";
import { SshSettings, SshAccess } from "./SshSettings";
import { SkillsSettings } from "./SkillsSettings";
import {
  UpdateSettings,
  updateReturnKey,
  useWorkspaceUpdates,
} from "./UpdateSettings";
import { RemovalConfirmation } from "./FolderActions";
import { Select } from "./Select";
import { ChatModelPicker } from "./ChatModelPicker";
import { ModelDefaults } from "./ModelDefaults";
import { AccountUsage } from "./AccountUsage";
import { ProviderIcon } from "./ProviderIcon";
import { modelLabel, effortLabel } from "../usage";
import { SidebarNavigation } from "./Sidebar";
import { WorkspaceHome } from "./WorkspaceHome";
import { useWorkspaceInstall, WorkspaceInstallGuide } from "./WorkspaceInstall";
import { AgentPermission } from "./AgentPermission";
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
  ArrowDown,
  Maximize2,
  Minimize2,
  Trash2,
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
  ArrowDownToLine,
  FileText,
  Image as ImageIcon,
  Activity,
  CircleHelp,
} from "lucide-react";
import { api, upload, socketUrl } from "./api";
import { ServerSettings } from "./ServerSettings";
import { ProjectWorkspaces } from "./ProjectWorkspaces";
import { WorkspaceFiles, workspaceLabel } from "./WorkspaceFiles";
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
  deleting: "Deleting…",
  delete_failed: "Removal incomplete — retry Delete",
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
  const returnToUpdates = history.state?.[updateReturnKey] === true;
  const [me, setMe] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [overview, setOverview] = useState<any>({
      projects: [],
      workspaces: [],
      chats: [],
      accounts: [],
    }),
    [chatId, setChatId] = useState<string | null>(
      new URLSearchParams(location.search).get("chat"),
    ),
    [projectId, setProjectId] = useState<string | null>(
      new URLSearchParams(location.search).get("project"),
    ),
    [newWorkspaceId, setNewWorkspaceId] = useState<string | null>(null),
    [viewingWorkspace, setViewingWorkspace] = useState<any>(null),
    [newProjectId, setNewProjectId] = useState<string | null>(null),
    [detail, setDetail] = useState<any>(null),
    [modal, setModal] = useState(returnToUpdates ? "settings" : ""),
    [settingsStart, setSettingsStart] = useState(
      returnToUpdates ? "updates" : "models",
    ),
    [editingChat, setEditingChat] = useState<any>(null),
    [chatActionBusy, setChatActionBusy] = useState(false),
    [editingProject, setEditingProject] = useState<any>(null),
    [error, setError] = useState(""),
    [mobile, setMobile] = useState(false),
    [showLatest, setShowLatest] = useState(false),
    [panelExpanded, setPanelExpanded] = useState(false),
    [panel, setPanel] = useState(""),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<any[]>([]),
    [searching, setSearching] = useState(false),
    [searchError, setSearchError] = useState(""),
    [streams, setStreams] = useState<Record<string, string>>({}),
    [liveLogs, setLiveLogs] = useState<ActivityEvent[]>([]),
    [workspaceRevision, setWorkspaceRevision] = useState(0),
    [connected, setConnected] = useState(false);
  const updates = useWorkspaceUpdates(Boolean(me), modal === "settings");
  const install = useWorkspaceInstall();
  const settingsButton = useRef<HTMLButtonElement>(null);
  const installFromMenu = useRef(false);
  useEffect(() => {
    if (!mobile) installFromMenu.current = false;
    if (installFromMenu.current && !install.showMenuEntry && !install.guide) {
      installFromMenu.current = false;
      settingsButton.current?.focus();
    }
  }, [mobile, install.showMenuEntry, install.guide]);
  const [text, setText] = useState(""),
    [drafts, setDrafts] = useState<any[]>([]),
    [sending, setSending] = useState(false),
    [drag, setDrag] = useState(false);
  const clientId = useRef(crypto.randomUUID()),
    fileInput = useRef<HTMLInputElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    nearBottom = useRef(true),
    responseScroll = useRef<string | null>(null),
    textDrafts = useRef<Record<string, string>>({}),
    currentChat = useRef(chatId);
  currentChat.current = chatId;
  const loadOverview = () =>
    api("/overview").then((next) => {
      setOverview(next);
      if (
        currentChat.current &&
        !next.chats.some((c: any) => c.id === currentChat.current)
      ) {
        setChatId(null);
        setDetail(null);
        setPanel("");
        setDrafts([]);
        setText("");
        history.replaceState({}, "", projectId ? "?project=" + projectId : "/");
      }
      return next;
    });
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
    if (!viewport) return;
    const style = document.documentElement.style;
    const updateViewport = () => {
      if (viewport.scale !== 1) return;
      style.setProperty("--app-height", `${viewport.height}px`);
      style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    };
    updateViewport();
    viewport.addEventListener("resize", updateViewport);
    viewport.addEventListener("scroll", updateViewport);
    return () => {
      viewport.removeEventListener("resize", updateViewport);
      viewport.removeEventListener("scroll", updateViewport);
      style.removeProperty("--app-height");
      style.removeProperty("--app-viewport-top");
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
      ).filter(
        (el) => el.getClientRects().length > 0 && !el.hasAttribute("disabled"),
      );
    controls()[0]?.focus();
    function keyboard(e: KeyboardEvent) {
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !document.querySelector("dialog[open], [popover]:popover-open")
      )
        setMobile(false);
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
  async function refreshAfterResponse() {
    responseScroll.current = chatId;
    try {
      await loadDetail();
    } catch (error) {
      responseScroll.current = null;
      throw error;
    }
  }
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
    if (history.state?.[updateReturnKey]) {
      const { [updateReturnKey]: _returnToUpdates, ...state } = history.state;
      history.replaceState(state, "");
    }
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
    setShowLatest(false);
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
        if (ev.type === "refresh") {
          setStreams({});
          void loadDetail(chatId);
          void loadOverview();
          return;
        }
        if (ev.type === "workspace-sync") {
          setWorkspaceRevision((revision) => revision + 1);
          return;
        }
        if (BigInt(ev.id) <= BigInt(cursor)) return;
        cursor = ev.id;
        if (
          ev.type === "status" &&
          !["running", "waiting_approval"].includes(ev.data.state)
        )
          setStreams((previous) => {
            const next = { ...previous };
            delete next[ev.job_id];
            return next;
          });
        if (ev.type === "delta")
          setStreams((s) => ({
            ...s,
            [ev.job_id]: (s[ev.job_id] || "") + ev.data.text,
          }));
        if (["tool", "log", "handoff", "warning"].includes(ev.type))
          setLiveLogs((s) => recentActivityEvents([...s, ev], 150));
        if (
          [
            "status",
            "approval",
            "handoff",
            "warning",
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
    if (nearBottom.current && detail?.approvals.length) {
      document
        .querySelector(".messages .agent-request")
        ?.scrollIntoView({ block: "start" });
    }
  }, [detail?.approvals.map((a: any) => a.id).join(",")]);
  useEffect(() => {
    if (responseScroll.current && responseScroll.current === detail?.chat.id) {
      responseScroll.current = null;
      const request = document.querySelector(".messages .agent-request");
      (request || bottom.current)?.scrollIntoView({
        block: request ? "start" : "end",
      });
    }
  }, [detail]);
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
  function newChat(
    id: string | null = chat?.project_id || projectId,
    workspaceId: string | null = null,
  ) {
    setNewWorkspaceId(workspaceId);
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
    if (name === "permissions") setModal("chat-permissions");
    if (name === "rename") setModal("chat-settings");
    if (["status", "usage"].includes(name)) setModal("chat-status");
    if (name === "clear")
      newChat(chat?.project_id || null, chat?.workspace_id || null);
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
  const composerModel = chat
    ? modelLabel(chat) +
      (chat.resolved_effort || chat.effort
        ? " · " + effortLabel(chat.resolved_effort || chat.effort)
        : "")
    : "";
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
          {mobile && install.showMenuEntry && (
            <button
              aria-disabled={install.prompting || undefined}
              onClick={() => {
                installFromMenu.current = true;
                void install.open();
              }}
            >
              <Download size={17} aria-hidden="true" />
              Install Workspace
            </button>
          )}
          {updates.shortcut && (
            <button
              onClick={() => {
                setSettingsStart("updates");
                setModal("settings");
              }}
            >
              <ArrowDownToLine size={17} aria-hidden="true" />
              {updates.shortcut}
            </button>
          )}
          <button
            ref={settingsButton}
            onClick={() => {
              setSettingsStart("models");
              setModal("settings");
            }}
          >
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
                {overview.projects.find((p: any) => p.id === chat.project_id)
                  ?.repo && (
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
            onUpdated={loadOverview}
            onFiles={(w: any) => {
              setViewingWorkspace(w);
              setModal("workspace-files");
            }}
          />
        ) : (
          <div
            className={
              "workspace " +
              (panel ? "with-panel" : "") +
              (panelExpanded ? " panel-expanded" : "")
            }
          >
            <section className="conversation">
              <div className="chat-context">
                <button
                  className="text-button chat-folder"
                  title={workspaceLabel(chat)}
                  aria-label={"Open files in " + workspaceLabel(chat)}
                  onClick={() => setPanel("files")}
                >
                  <FolderGit2 size={14} />
                  <span>{workspaceLabel(chat)}</span>
                </button>
                <button
                  className="text-button chat-account"
                  title="Switch agent account"
                  aria-label={
                    "Switch account: " + (account?.name || "Choose account")
                  }
                  onClick={() => setModal("switch")}
                >
                  <ProviderIcon
                    provider={chat.provider}
                    size={14}
                    className="provider-symbol"
                  />
                  <span className="chat-account-name">
                    {account?.name || "Choose account"}
                  </span>
                  <ArrowRightLeft size={14} />
                  <span className="chat-switch-label">Switch account</span>
                </button>
                {chat.mode === "plan" && (
                  <span className="chat-context-mode">Plan mode</span>
                )}
              </div>
              {detail.jobs[0]?.state === "queued" &&
                overview.chats.some(
                  (c: any) =>
                    c.workspace_id === chat.workspace_id &&
                    c.id !== chat.id &&
                    ["running", "waiting_approval"].includes(c.state),
                ) && (
                  <p className="chat-folder-wait" role="status">
                    Waiting for another chat to finish using this folder.
                  </p>
                )}
              {[
                ...new Map(
                  [...detail.events, ...liveLogs]
                    .filter(
                      (e: any) =>
                        e.type === "warning" &&
                        e.job_id === detail.jobs?.[0]?.id,
                    )
                    .map((e: any) => [e.id, e]),
                ).values(),
              ].map((e: any) => (
                <div className="run-notice" role="alert" key={e.id}>
                  {e.data.message}
                </div>
              ))}
              {!account && (
                <div className="run-notice">
                  <p>
                    Choose an account to continue this chat. Your messages and
                    files are preserved.
                  </p>
                  <button
                    className="secondary"
                    onClick={() => setModal("switch")}
                  >
                    Choose account
                  </button>
                </div>
              )}
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
                role="region"
                aria-label="Conversation"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  nearBottom.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                  setShowLatest(!nearBottom.current);
                }}
              >
                {!detail.messages.length && (
                  <div className="chat-start">
                    <span className="agent-orb">
                      <ProviderIcon provider={chat.provider} size={36} />
                    </span>
                    <h2>What are we working on?</h2>
                    <p>Describe a task, ask a question, or attach a file.</p>
                    <span className="branch-label">
                      <GitBranch size={14} />
                      {overview.projects.find(
                        (p: any) => p.id === chat.project_id,
                      )?.repo
                        ? chat.branch
                        : workspaceLabel(chat)}
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
                    <div className="message-content">
                      <div className="message-heading">
                        <span
                          className={
                            "message-avatar" +
                            (m.role === "user"
                              ? ""
                              : " " + (m.provider || chat.provider))
                          }
                          aria-hidden="true"
                        >
                          {m.role === "user" ? (
                            "Y"
                          ) : (
                            <ProviderIcon
                              provider={m.provider || chat.provider}
                              size={17}
                            />
                          )}
                        </span>

                        {m.role === "user"
                          ? "You"
                          : (m.provider || chat.provider) === "codex"
                            ? "Codex"
                            : "Claude Code"}
                        <time
                          dateTime={m.created_at}
                          title={new Date(m.created_at).toLocaleString()}
                        >
                          {new Date(m.created_at).toLocaleTimeString("en-GB", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <ChatMarkdown
                        text={m.content}
                        chatId={m.role === "assistant" ? chat.id : undefined}
                      />
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
                    <div className="message-content">
                      <div className="message-heading" role="status">
                        <span
                          className={"message-avatar " + chat.provider}
                          aria-hidden="true"
                        >
                          <ProviderIcon provider={chat.provider} size={17} />
                        </span>
                        {job.state === "waiting_approval"
                          ? detail.approvals.some(
                              (a: any) => a.kind === "question",
                            )
                            ? "Waiting for your answer"
                            : "Waiting for permission"
                          : labels[job.state]}
                        {job.state === "running" && (
                          <LoaderCircle size={13} className="spin" />
                        )}
                      </div>
                      <ChatMarkdown
                        chatId={chat.id}
                        text={
                          streams[job.id] ||
                          (job.state === "waiting_approval"
                            ? "Review the request below to continue."
                            : "Your agent is preparing the workspace…")
                        }
                      />
                    </div>
                  </article>
                )}
                <ActivityLog
                  key={chat.id}
                  history={detail.events}
                  live={liveLogs}
                  running={job?.state === "running"}
                  latestJobId={detail.jobs[0]?.id ?? null}
                />
                {detail.approvals.map((a: any) =>
                  a.kind === "question" ? (
                    <AgentQuestions
                      key={a.id}
                      request={a}
                      onAnswered={refreshAfterResponse}
                    />
                  ) : (
                    <AgentPermission
                      key={a.id}
                      request={a}
                      onAnswered={refreshAfterResponse}
                    />
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
                {showLatest && !detail.approvals.length && (
                  <button
                    className="chat-latest secondary"
                    onClick={() => {
                      nearBottom.current = true;
                      setShowLatest(false);
                      bottom.current?.scrollIntoView({ block: "end" });
                    }}
                  >
                    <ArrowDown size={14} />
                    Latest messages
                  </button>
                )}
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
                      className="permission-chip model-chip"
                      onClick={() => setModal("chat-model")}
                      aria-label={"Model: " + composerModel}
                      title={composerModel}
                    >
                      <span>{composerModel}</span>
                      <ChevronDown size={12} />
                    </button>
                    <button
                      className={
                        "permission-chip " +
                        (chat.autonomous ? "is-autonomous" : "")
                      }
                      aria-label={
                        "Permissions: " +
                        (chat.autonomous ? "Autonomous" : "Ask for permission")
                      }
                      title={
                        chat.autonomous
                          ? "Autonomous actions enabled"
                          : "Ask for permission before actions"
                      }
                      onClick={() => setModal("chat-permissions")}
                    >
                      <ShieldCheck size={14} />
                      <span>
                        {chat.autonomous ? "Autonomous" : "Approvals"}
                      </span>
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
                  <span className="composer-hint">
                    {busy
                      ? "Agent is working · your draft stays here"
                      : "Enter to send · Shift + Enter for a new line"}
                  </span>
                  <button
                    className="text-button composer-help"
                    aria-label="Commands and help"
                    onClick={() => setModal("composer-help")}
                  >
                    <CircleHelp size={13} />
                    <span>Commands & help</span>
                  </button>
                </div>
              </div>
            </section>
            {panel && (
              <aside className="work-panel">
                <header>
                  <div className="work-panel-title">
                    <strong>
                      {panel === "terminal" ? (
                        <TerminalIcon size={16} />
                      ) : panel === "diff" ? (
                        <GitBranch size={16} />
                      ) : (
                        <Files size={16} />
                      )}
                      {
                        {
                          files: "Files",
                          diff: "Changes",
                          terminal: "Terminal",
                        }[panel]
                      }
                    </strong>
                    <span title={workspaceLabel(chat)}>
                      {workspaceLabel(chat)}
                    </span>
                  </div>
                  <div className="work-panel-controls">
                    <button
                      className="icon-button panel-expand"
                      aria-label={
                        panelExpanded ? "Restore panel size" : "Expand panel"
                      }
                      title={
                        panelExpanded ? "Restore panel size" : "Expand panel"
                      }
                      onClick={() => setPanelExpanded(!panelExpanded)}
                    >
                      {panelExpanded ? (
                        <Minimize2 size={16} />
                      ) : (
                        <Maximize2 size={16} />
                      )}
                    </button>
                    <button
                      className="icon-button panel-back"
                      aria-label="Back to chat"
                      title="Back to chat"
                      onClick={() => {
                        setPanel("");
                        setPanelExpanded(false);
                      }}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </header>
                {panel === "files" ? (
                  <WorkspaceFiles
                    key={chat.workspace_id}
                    workspace={
                      overview.workspaces.find(
                        (w: any) => w.id === chat.workspace_id,
                      ) || {
                        id: chat.workspace_id,
                        project_id: chat.project_id,
                        kind: chat.workspace_kind,
                        name: chat.workspace_name,
                        initialized: chat.initialized,
                      }
                    }
                    onUpdated={async () => {
                      await loadOverview();
                      await loadDetail();
                    }}
                  />
                ) : panel === "terminal" ? (
                  <Suspense
                    fallback={<p className="muted">Opening terminal…</p>}
                  >
                    <Terminal chatId={chat.id} />
                  </Suspense>
                ) : (
                  <ChangesPanel
                    key={chat.id}
                    chatId={chat.id}
                    revision={workspaceRevision}
                    syncFolder={
                      project?.repo &&
                      chat.initialized &&
                      !overview.workspaces.find(
                        (w: any) => w.id === chat.workspace_id,
                      )?.resolution_operation_id
                        ? chat.workspace_id
                        : undefined
                    }
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
          <details className="settings-disclosure">
            <summary>Working folders</summary>
            <ProjectWorkspaces
              embedded
              key={editingProject.id}
              project={editingProject}
              workspaces={overview.workspaces}
              onUpdated={async () => {
                const next = await loadOverview();
                if (
                  currentChat.current &&
                  next.chats.some((c: any) => c.id === currentChat.current)
                )
                  await loadDetail();
              }}
              onFiles={(w: any) => {
                setViewingWorkspace(w);
                setModal("workspace-files");
              }}
              onNew={newChat}
              onOpenChat={(id: string) => {
                selectChat(id);
                setModal("");
              }}
            />
          </details>
          <details className="settings-disclosure">
            <summary>Connected folders</summary>
            <Folders scope="projects" id={editingProject.id} />
          </details>
        </Modal>
      )}
      {modal === "workspace-files" && viewingWorkspace && (
        <Modal
          className="workspace-files-modal"
          title={workspaceLabel(
            overview.workspaces.find(
              (w: any) => w.id === viewingWorkspace.id,
            ) || viewingWorkspace,
          )}
          onClose={() => setModal("")}
        >
          <WorkspaceFiles
            key={viewingWorkspace.id}
            workspace={
              overview.workspaces.find(
                (w: any) => w.id === viewingWorkspace.id,
              ) || viewingWorkspace
            }
            onUpdated={loadOverview}
          />
        </Modal>
      )}
      {modal === "chat" && (
        <Modal
          error={error}
          title="New chat"
          className="new-chat-modal"
          onClose={() => setModal("")}
        >
          <NewChat
            overview={overview}
            initialProjectId={newProjectId}
            initialWorkspaceId={newWorkspaceId}
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
          className="accounts-modal"
          onClose={() => {
            setModal("");
            void loadOverview();
          }}
        >
          <Accounts
            accounts={overview.accounts}
            refresh={async () => {
              await loadOverview();
              if (currentChat.current) await loadDetail();
            }}
            onError={setError}
          />
        </Modal>
      )}
      {modal === "switch" && chat && (
        <Modal
          title="Switch agent account"
          className="account-switch-modal"
          onClose={() => setModal("")}
        >
          <AccountSwitcher
            key={chat.id}
            accounts={overview.accounts}
            currentId={chat.account_id}
            provider={chat.provider}
            runState={job?.state}
            onCancel={() => setModal("")}
            onManage={() => {
              setError("");
              setModal("accounts");
            }}
            onSwitch={async (id) => {
              await api(`/chats/${chat.id}/switch`, { account_id: id });
              setModal("");
              await run(async () => {
                await Promise.all([loadDetail(), loadOverview()]);
              });
            }}
          />
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
            Delete <strong>{editingChat.title}</strong> and its conversation
            history? This cannot be undone.
          </p>
          <p className="muted">
            Working files and original attachments are kept in the working
            folder, available from the project or home page. Stop any active
            task and close this chat’s terminal first.
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
          className="chat-picker-modal chat-model-modal"
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
      {modal === "chat-permissions" && chat && (
        <Modal
          title="Permissions"
          className="chat-picker-modal"
          error={error}
          onClose={() => setModal("")}
        >
          <ChatPermissions
            key={chat.id}
            autonomous={chat.autonomous}
            onClose={() => setModal("")}
            onError={setError}
            onSave={async (autonomous) => {
              await api(
                `/chats/${chat.id}/permissions`,
                { autonomous },
                "PATCH",
              );
              await loadDetail();
              setModal("");
            }}
          />
        </Modal>
      )}
      {modal === "chat-settings" && chat && (
        <Modal
          error={error}
          title="Chat settings"
          className="chat-settings-modal"
          onClose={() => setModal("")}
        >
          <ChatSettings
            key={chat.id}
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
          <details className="settings-disclosure">
            <summary>Server access</summary>
            <SshAccess embedded scope="chats" id={chat.id} />
          </details>
          <details className="settings-disclosure">
            <summary>Connected folders</summary>
            <Folders
              scope="chats"
              id={chat.id}
              readOnlyOnly={chat.workspace_kind === "copy"}
            />
          </details>
          <div className="chat-settings-danger">
            <button
              type="button"
              className="text-button quiet-danger"
              onClick={() => {
                setEditingChat(chat);
                setModal("delete-chat");
              }}
            >
              <Trash2 size={15} /> Delete chat…
            </button>
          </div>
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
            initialSection={settingsStart}
            install={install}
            updates={updates}
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
      {install.guide && (
        <Modal
          title="Install Workspace"
          className="workspace-install-modal"
          onClose={install.closeGuide}
        >
          <WorkspaceInstallGuide
            platform={install.guide}
            onClose={install.closeGuide}
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
  initialWorkspaceId,
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
  const [selectedProject, setSelectedProject] = useState(
    initialProjectId || "",
  );
  const [selectedWorkspace, setSelectedWorkspace] = useState(
    overview.workspaces.find((w: any) => w.id === initialWorkspaceId)?.kind ===
      "main"
      ? ""
      : initialWorkspaceId || "",
  );
  const [folderMode, setFolderMode] = useState<"main" | "copy" | "existing">(
    initialWorkspaceId &&
      overview.workspaces.find((w: any) => w.id === initialWorkspaceId)
        ?.kind !== "main"
      ? "existing"
      : "main",
  );
  const [copyName, setCopyName] = useState("");
  const [createdCopy, setCreatedCopy] = useState<any>(null);
  const [creatingCopy, setCreatingCopy] = useState(false);
  const folders = [
    ...overview.workspaces,
    ...(createdCopy &&
    !overview.workspaces.some((w: any) => w.id === createdCopy.id)
      ? [createdCopy]
      : []),
  ].filter((w: any) => w.project_id === (selectedProject || null));
  const mainFolder = folders.find((w: any) => w.kind === "main");
  const existingFolders = folders.filter(
    (w: any) => w.kind !== "main" && w.status === "ready",
  );
  const needsMain =
    selectedProject &&
    folderMode !== "existing" &&
    !mainFolder &&
    folders.length > 0;
  const invalidFolder =
    !!selectedProject &&
    (folderMode === "copy"
      ? !mainFolder || mainFolder.status !== "ready" || !copyName.trim()
      : folderMode === "existing"
        ? !existingFolders.some((w: any) => w.id === selectedWorkspace)
        : !!mainFolder && mainFolder.status !== "ready");
  const accounts = overview.accounts.filter(
    (a: any) => a.provider === provider,
  );
  const selectedAccount = accounts.find((a: any) => a.id === accountId);
  const defaults = overview.modelDefaults?.[provider];
  const [modelPreview, setModelPreview] = useState({ model: "", effort: "" });
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
      className="new-chat-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (creating || !accountId || needsMain || invalidFolder) return;
        setCreating(true);
        onError("");
        const f = new FormData(e.currentTarget);
        let freshCopy: any = null;
        try {
          let workspaceId =
            selectedProject && folderMode === "main" ? "" : selectedWorkspace;
          if (selectedProject && folderMode === "copy") {
            setCreatingCopy(true);
            freshCopy = await api(`/workspaces/${mainFolder.id}/copies`, {
              name: copyName.trim(),
            });
            workspaceId = freshCopy.id;
            // Retain the successful copy if chat creation fails. A retry uses it.
            setCreatedCopy(freshCopy);
            setSelectedWorkspace(freshCopy.id);
            setFolderMode("existing");
            setCreatingCopy(false);
          }
          const c = await api("/chats", {
            project_id: selectedProject || null,
            ...(workspaceId ? { workspace_id: workspaceId } : {}),
            provider,
            account_id: accountId,
            model: f.get("model") || "",
            effort: f.get("effort") || "",
            autonomous: f.get("autonomous") === "on",
          });
          await onCreated(c);
        } catch (e: any) {
          onError(
            freshCopy
              ? `Working copy “${freshCopy.name}” was created, but the chat could not be opened. Retry Create chat to use this copy. ${e.message}`
              : e.message,
          );
        } finally {
          setCreatingCopy(false);
          setCreating(false);
        }
      }}
    >
      <fieldset className="form-fields" disabled={creating}>
        <Field label="Project">
          <Select
            aria-label="Project"
            name="project"
            value={selectedProject}
            onChange={(e) => {
              setSelectedProject(e.target.value);
              setSelectedWorkspace("");
              setFolderMode("main");
              setCopyName("");
            }}
          >
            <option value="">Personal chat</option>
            {overview.projects.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {selectedProject ? (
          <details className="settings-disclosure new-chat-location" open>
            <summary>Working folder</summary>
            <div className="chat-settings-section">
              <fieldset className="chat-folder-choice">
                <legend className="visually-hidden">
                  Where should this chat work?
                </legend>
                <div className="chat-folder-options">
                  <label
                    className={
                      "chat-folder-option " +
                      (folderMode === "main" ? "selected" : "")
                    }
                  >
                    <input
                      type="radio"
                      name="folder-mode"
                      value="main"
                      checked={folderMode === "main"}
                      onChange={() => setFolderMode("main")}
                    />
                    <span>
                      <strong>
                        <FolderGit2 size={17} /> Main folder
                      </strong>
                      <small>Shared files · one task at a time.</small>
                    </span>
                  </label>
                  <label
                    className={
                      "chat-folder-option " +
                      (folderMode === "copy" ? "selected" : "") +
                      (!mainFolder || mainFolder.status !== "ready"
                        ? " unavailable"
                        : "")
                    }
                  >
                    <input
                      type="radio"
                      name="folder-mode"
                      value="copy"
                      checked={folderMode === "copy"}
                      disabled={!mainFolder || mainFolder.status !== "ready"}
                      onChange={() => setFolderMode("copy")}
                    />
                    <span>
                      <strong>
                        <GitBranch size={17} /> New working copy
                      </strong>
                      <small>
                        Work separately, then review and transfer changes.
                      </small>
                    </span>
                  </label>
                  {!!existingFolders.length && (
                    <label
                      className={
                        "chat-folder-option existing " +
                        (folderMode === "existing" ? "selected" : "")
                      }
                    >
                      <input
                        type="radio"
                        name="folder-mode"
                        value="existing"
                        checked={folderMode === "existing"}
                        onChange={() => {
                          setFolderMode("existing");
                          if (
                            !existingFolders.some(
                              (w: any) => w.id === selectedWorkspace,
                            )
                          )
                            setSelectedWorkspace(existingFolders[0].id);
                        }}
                      />
                      <span>
                        <strong>
                          <FolderGit2 size={17} /> Existing folder
                        </strong>
                        <small>
                          Continue in a working copy or saved folder.
                        </small>
                      </span>
                    </label>
                  )}
                </div>
                {folderMode === "copy" && (
                  <div className="chat-folder-detail">
                    <Field label="Working copy name">
                      <input
                        name="copy-name"
                        autoComplete="off"
                        required
                        maxLength={80}
                        value={copyName}
                        onChange={(e) => setCopyName(e.target.value)}
                        placeholder="For example: Update the homepage"
                      />
                    </Field>
                    <p className="muted">
                      The copy and chat are created together. Dependencies,
                      build output and local secret files are excluded.
                      Connected folders are read-only.
                    </p>
                    <p className="muted">
                      Parallel tasks need separate available agent accounts.
                      External services and databases remain shared.
                    </p>
                  </div>
                )}
                {folderMode === "existing" && (
                  <Field label="Working folder">
                    <Select
                      aria-label="Working folder"
                      value={selectedWorkspace}
                      onChange={(e) => setSelectedWorkspace(e.target.value)}
                    >
                      {existingFolders.map((w: any) => (
                        <option value={w.id} key={w.id}>
                          {workspaceLabel(w)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {needsMain && (
                  <p className="inline-error" role="alert">
                    Choose the main folder in Project settings first, or
                    continue in an existing saved folder.
                  </p>
                )}
              </fieldset>
            </div>
          </details>
        ) : (
          <>
            <Field label="Working folder">
              <Select
                aria-label="Working folder"
                value={selectedWorkspace}
                onChange={(e) => setSelectedWorkspace(e.target.value)}
              >
                <option value="">New personal folder</option>
                {existingFolders.map((w: any) => (
                  <option value={w.id} key={w.id}>
                    {workspaceLabel(w)}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="muted">
              Chats in the same folder share files and run one task at a time.
            </p>
          </>
        )}
        <section className="new-chat-agent" aria-label="Agent and account">
          <h3>Agent</h3>
          <div
            className="segmented"
            role="group"
            aria-label="Choose your agent"
          >
            <button
              type="button"
              aria-pressed={provider === "codex"}
              className={provider === "codex" ? "selected" : ""}
              onClick={() => selectProvider("codex")}
            >
              <ProviderIcon provider="codex" size={16} /> Codex
            </button>
            <button
              type="button"
              aria-pressed={provider === "claude"}
              className={provider === "claude" ? "selected" : ""}
              onClick={() => selectProvider("claude")}
            >
              <ProviderIcon provider="claude" size={16} /> Claude Code
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
                Add a {provider === "codex" ? "Codex" : "Claude Code"} account
                to use this agent.
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
              You can create this chat now. Connect the account in Agent
              accounts before sending a task.
            </p>
          )}
        </section>
        <details className="settings-disclosure">
          <summary>
            <span className="settings-summary-caption">
              Model &amp; thinking
              {modelPreview.model && (
                <small>
                  {modelPreview.model}
                  {modelPreview.effort
                    ? " · " + effortLabel(modelPreview.effort)
                    : ""}
                </small>
              )}
            </span>
          </summary>
          <div className="chat-settings-section chat-settings-model">
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
              onSelectionChange={setModelPreview}
            />
          </div>
        </details>
        <details className="settings-disclosure">
          <summary>Permissions</summary>
          <div className="chat-settings-section">
            <label className="chat-permission-row">
              <ShieldCheck size={18} aria-hidden="true" />
              <span>
                <strong>Run without approval prompts</strong>
                <small>
                  Allow commands and file edits without asking. Leave off to
                  review permission requests.
                </small>
              </span>
              <input name="autonomous" type="checkbox" />
            </label>
          </div>
        </details>
        <div className="new-chat-footer">
          <p className="settings-section-note">
            Your first message becomes the chat title.
          </p>
          <button
            className="primary"
            disabled={!accountId || creating || !!needsMain || invalidFolder}
          >
            <Plus size={17} />
            {creatingCopy
              ? "Creating working copy…"
              : creating
                ? "Creating chat…"
                : selectedProject && folderMode === "copy"
                  ? "Create copy and chat"
                  : "Create chat"}
          </button>
        </div>
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
    [removing, setRemoving] = useState<any>(null),
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
        Connect your Codex or Claude Code accounts to start working.
      </p>
      {!!accounts.length && (
        <div className="accounts-summary">
          <h3>Your accounts</h3>
          <span>
            {accounts.filter((a: any) => a.status === "ready").length} connected
          </span>
        </div>
      )}
      <div className="account-list">
        {[
          { id: "codex", name: "Codex" },
          { id: "claude", name: "Claude Code" },
        ]
          .filter((service) =>
            accounts.some((a: any) => a.provider === service.id),
          )
          .map((service) => (
            <section
              className="account-group"
              key={service.id}
              aria-label={service.name + " accounts"}
            >
              <header>
                <strong className="service-name">
                  <ProviderIcon provider={service.id} size={16} />
                  {service.name}
                </strong>
                <span>
                  {
                    accounts.filter((a: any) => a.provider === service.id)
                      .length
                  }{" "}
                  {accounts.filter((a: any) => a.provider === service.id)
                    .length === 1
                    ? "account"
                    : "accounts"}
                </span>
              </header>
              {accounts
                .filter((a: any) => a.provider === service.id)
                .map((a: any) => (
                  <div className="account-entry" key={a.id}>
                    <div className="account-row">
                      <span className={"provider-icon " + a.provider}>
                        <ProviderIcon provider={a.provider} size={20} />
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          <span className={"status-dot " + a.status} />
                          {labels[a.status]}
                        </small>
                      </div>
                      <div className="account-action-buttons">
                        {["ready", "limited", "disconnect_failed"].includes(
                          a.status,
                        ) ? (
                          <button
                            className="text-button"
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
                              a.status === "deleting" ||
                              a.status === "delete_failed" ||
                              a.status === "inspecting"
                            }
                            onClick={() => start(a.id)}
                          >
                            Connect
                          </button>
                        )}
                        <button
                          className="icon-button quiet-danger"
                          aria-label={"Delete account " + a.name}
                          title={"Delete account " + a.name}
                          disabled={
                            !!disconnecting ||
                            connecting ||
                            [
                              "authenticating",
                              "inspecting",
                              "disconnecting",
                              "deleting",
                            ].includes(a.status)
                          }
                          onClick={() => setRemoving(a)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>
                    <div className="account-limits">
                      <AccountUsage account={a} refresh={refresh} compact />
                    </div>
                    {removing?.id === a.id && (
                      <RemovalConfirmation
                        requireName={false}
                        key={removing.id}
                        name={removing.name}
                        busy={!!disconnecting}
                        description="This removes the account and saved sign-in data from this app. Chats, messages and project files are kept. Choose another account to continue those chats. Your Codex or Claude subscription is not affected."
                        onCancel={() => setRemoving(null)}
                        onConfirm={async () => {
                          setDisconnecting(removing.id);
                          try {
                            await api(
                              "/accounts/" + removing.id,
                              { name: removing.name },
                              "DELETE",
                            );
                            if (authId === removing.id) {
                              setAuthId("");
                              setEvents([]);
                            }
                            setRemoving(null);
                          } catch (e: any) {
                            onError(e.message);
                          } finally {
                            setDisconnecting("");
                            await refresh();
                          }
                        }}
                      />
                    )}
                  </div>
                ))}
            </section>
          ))}
      </div>
      <details className="settings-disclosure" open={!accounts.length}>
        <summary>
          {accounts.length ? "Add account" : "Connect your first account"}
        </summary>
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
              setAdded(`${name} added. Select Connect to sign in.`);
              await refresh();
            } catch (e: any) {
              onError(e.message);
            } finally {
              setAdding(false);
            }
          }}
        >
          <div className="form-row">
            <Field label="Account label">
              <input
                name="name"
                required
                maxLength={80}
                placeholder="e.g. Personal or Work"
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
          <div className="settings-section-footer">
            <button className="primary" disabled={adding}>
              <Plus size={17} />
              {adding ? "Adding account…" : "Add account"}
            </button>
          </div>
        </form>
      </details>
      {added && (
        <p className="account-added" role="status">
          {added}
        </p>
      )}
      <p className="accounts-footnote">
        One task runs per account. Set parallel capacity in Settings →
        Resources.
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
function ChatPermissions({
  autonomous,
  onSave,
  onClose,
  onError,
}: {
  autonomous: boolean;
  onSave: (autonomous: boolean) => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const data = new FormData(e.currentTarget);
        setSaving(true);
        onError("");
        try {
          await onSave(data.get("approvalMode") === "autonomous");
        } catch (e: any) {
          onError(e.message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={saving} className="form-fields">
        <Field label="Approval mode">
          <Select
            aria-label="Approval mode"
            name="approvalMode"
            defaultValue={autonomous ? "autonomous" : "ask"}
          >
            <option value="ask">Ask for permission</option>
            <option value="autonomous">Autonomous</option>
          </Select>
        </Field>
        <div className="chat-dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">{saving ? "Saving…" : "Apply"}</button>
        </div>
      </fieldset>
    </form>
  );
}
function ChatSettings({ chat, me, onSave, onError }: any) {
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="chat-settings-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const f = new FormData(e.currentTarget);
        setSaving(true);
        onError("");
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
      <fieldset className="form-fields" disabled={saving}>
        <Field label="Chat name">
          <input
            name="title"
            defaultValue={chat.title}
            maxLength={160}
            required
          />
        </Field>
        <details className="settings-disclosure" open>
          <summary>Model &amp; thinking</summary>
          <div className="chat-settings-section chat-settings-model">
            <p className="settings-section-intro">
              {chat.provider === "codex" ? "Codex" : "Claude Code"} · Applies to
              future messages in this chat.
            </p>
            <ModelOptions
              provider={chat.provider}
              accountId={chat.account_id}
              initialModel={chat.model}
              initialEffort={chat.effort}
            />
          </div>
        </details>
        <details className="settings-disclosure">
          <summary>Permissions &amp; accounts</summary>
          <div className="chat-settings-section">
            <label className="chat-permission-row">
              <ShieldCheck size={18} aria-hidden="true" />
              <span>
                <strong>Run without approval prompts</strong>
                <small>
                  Allow commands and file edits without asking. Leave off to
                  review permission requests.
                </small>
              </span>
              <input
                name="autonomous"
                type="checkbox"
                defaultChecked={chat.autonomous}
              />
            </label>
            <Field label="Account switching">
              <Select
                aria-label="Account switching"
                name="handoff"
                defaultValue={chat.handoff}
              >
                <option value="manual">Choose manually</option>
                <option value="auto" disabled={!me.autoHandoff}>
                  Automatically{!me.autoHandoff ? " — unavailable" : ""}
                </option>
              </Select>
            </Field>
            {!me.autoHandoff && (
              <p className="settings-section-note">
                Automatic switching requires verification and activation.
              </p>
            )}
          </div>
        </details>
        <div className="chat-settings-save">
          <button className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
function SettingsForm({
  initialSection,
  install,
  updates,
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
    [enabling, setEnabling] = useState(false),
    [selectedSection, setSection] = useState(initialSection);
  const section =
    selectedSection === "app" && !install.available
      ? "models"
      : selectedSection;
  const settingsLayoutRef = useRef<HTMLDivElement>(null);
  const installButton = useRef<HTMLButtonElement>(null);
  const hadInstallGuide = useRef(false);
  useEffect(() => {
    if (hadInstallGuide.current && !install.guide)
      installButton.current?.focus();
    hadInstallGuide.current = Boolean(install.guide);
  }, [install.guide]);
  const sections = [
    { id: "models", label: "Models" },
    { id: "connections", label: "Connections" },
    { id: "ssh", label: "Servers & SSH" },
    { id: "skills", label: "Skills" },
    { id: "resources", label: "Resources" },
    { id: "updates", label: "Updates" },
    { id: "notifications", label: "Notifications" },
    ...(install.available ? [{ id: "app", label: "App" }] : []),
  ];
  function selectSection(next: string) {
    setSection(next);
    onError("");
    settingsLayoutRef.current?.closest("dialog")?.scrollTo({ top: 0 });
  }
  async function push() {
    if (enabling) return;
    setEnabling(true);
    onError("");
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
    } finally {
      setEnabling(false);
    }
  }
  return (
    <div className="settings-layout" ref={settingsLayoutRef}>
      <div
        className="segmented settings-tabs"
        role="tablist"
        aria-label="Settings sections"
      >
        {sections.map((item) => (
          <button
            key={item.id}
            id={"settings-tab-" + item.id}
            type="button"
            role="tab"
            tabIndex={section === item.id ? 0 : -1}
            onKeyDown={(event) => {
              const direction = {
                ArrowRight: 1,
                ArrowDown: 1,
                ArrowLeft: -1,
                ArrowUp: -1,
              }[event.key];
              if (!direction && event.key !== "Home" && event.key !== "End")
                return;
              event.preventDefault();
              const tabs = Array.from(
                event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = tabs.indexOf(event.currentTarget);
              const target =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index + (direction || 0) + tabs.length) % tabs.length;
              tabs[target].focus();
              tabs[target].click();
            }}
            aria-selected={section === item.id}
            aria-controls={"settings-panel-" + item.id}
            className={section === item.id ? "selected" : ""}
            onClick={() => {
              selectSection(item.id);
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
      {section === "ssh" && (
        <div
          role="tabpanel"
          id="settings-panel-ssh"
          aria-labelledby="settings-tab-ssh"
        >
          <SshSettings />
        </div>
      )}
      {section === "skills" && (
        <div
          role="tabpanel"
          id="settings-panel-skills"
          aria-labelledby="settings-tab-skills"
        >
          <SkillsSettings />
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
      {section === "updates" && (
        <div
          role="tabpanel"
          id="settings-panel-updates"
          aria-labelledby="settings-tab-updates"
        >
          <UpdateSettings {...updates} />
        </div>
      )}
      {section === "connections" && (
        <div
          role="tabpanel"
          id="settings-panel-connections"
          aria-labelledby="settings-tab-connections"
        >
          <header className="workspace-settings-heading">
            <h3>Connections</h3>
            <p className="muted">
              Each project has its own GitHub token. Chats can also run without
              a repository.
            </p>
          </header>
          <section
            className="workspace-settings-card connections-card"
            aria-label="Connected projects"
          >
            <header className="settings-card-heading">
              <h4>Projects</h4>
              <span>{projects.length}</span>
            </header>
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
                      {p.repo
                        ? `${p.repo} · ${p.github_configured ? "Token saved" : "No token"}`
                        : "Files-only project"}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
            {!projects.length && (
              <div className="settings-section-empty">
                <FolderGit2 size={20} aria-hidden="true" />
                <div>
                  <strong>No projects connected</strong>
                  <span>Add a repository or a files-only project.</span>
                </div>
              </div>
            )}
            <button className="text-button" onClick={onAdd}>
              <Plus size={16} />
              Connect a project
            </button>
          </section>
        </div>
      )}
      {section === "notifications" && (
        <div
          role="tabpanel"
          id="settings-panel-notifications"
          aria-labelledby="settings-tab-notifications"
        >
          <header className="workspace-settings-heading">
            <h3>Notifications</h3>
            <p className="muted">
              Get notified when a task finishes or your agent needs permission.
            </p>
          </header>
          <section
            className="workspace-settings-card notification-settings"
            aria-label="Device notifications"
          >
            <header className="settings-card-heading">
              <h4>This device</h4>
            </header>
            <div className="notification-settings-row">
              <Bell size={20} aria-hidden="true" />
              <div>
                <strong>Task updates</strong>
                <small>Finished tasks and requests for your approval.</small>
              </div>
            </div>
            <p className="settings-section-note">
              Applies to this browser or installed app.
            </p>
            {!me.vapidKey && (
              <p className="settings-section-note">
                Notifications must be configured on the server first.
              </p>
            )}
            <div className="settings-card-actions">
              <button
                className="primary"
                onClick={push}
                disabled={enabling || saved || !me.vapidKey}
              >
                {enabling
                  ? "Enabling…"
                  : saved
                    ? "Enabled on this device"
                    : "Enable on this device"}
              </button>
            </div>
            {saved && (
              <p className="success" role="status">
                <Check size={16} />
                Notifications enabled.
              </p>
            )}
          </section>
        </div>
      )}
      {section === "app" && (
        <div
          role="tabpanel"
          id="settings-panel-app"
          aria-labelledby="settings-tab-app"
        >
          <header className="workspace-settings-heading">
            <h3>Workspace app</h3>
            <p className="muted">Open Workspace from your Home Screen.</p>
          </header>
          <section
            className="workspace-settings-card"
            aria-label="App installation"
          >
            <button
              type="button"
              className="secondary"
              ref={installButton}
              onClick={install.open}
              aria-disabled={install.prompting || undefined}
            >
              <Download size={16} aria-hidden="true" />
              Install Workspace
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function ConnectProject({
  onCreated,
}: {
  onCreated: (project: any) => Promise<void>;
}) {
  const [projectType, setProjectType] = useState("git");
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [projectTokenInput, setProjectTokenInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const normalized = normalizeGithubRepo(repository);
  return (
    <>
      <fieldset className="workspace-mode-options" disabled={busy}>
        <legend>Project type</legend>
        {[
          {
            value: "git",
            label: "GitHub repository",
            detail: "Work on code with branches and separate working copies.",
          },
          {
            value: "files",
            label: "Files only",
            detail: "Upload documents and files. No repository needed.",
          },
        ].map((option) => (
          <label
            key={option.value}
            className={projectType === option.value ? "selected" : ""}
          >
            <input
              type="radio"
              name="project-type"
              checked={projectType === option.value}
              onChange={() => {
                setProjectType(option.value);
                setError("");
              }}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.detail}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          if (projectType === "git" && !normalized) {
            setError("Enter owner/repository or a GitHub repository URL.");
            return;
          }
          setBusy(true);
          setError("");
          try {
            const created = await api("/projects", {
              repo: projectType === "git" ? repository : "",
              ...(projectType === "files" ? { name: name.trim() } : {}),
              ...(projectType === "git" && projectTokenInput.trim()
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
        {projectType === "files" ? (
          <Field label="Project name">
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="For example: Marketing materials"
            />
          </Field>
        ) : (
          <>
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
          </>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          <FolderGit2 size={17} />
          {busy
            ? "Creating…"
            : projectType === "git"
              ? "Connect repository"
              : "Create project"}
        </button>
      </form>
    </>
  );
}
