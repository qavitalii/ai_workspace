import { AccountUsage } from "./AccountUsage";
import { modelLabel } from "../usage";
import { useEffect, useState, useRef, useId } from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Home,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Pencil,
  Trash2,
  Check,
  Search,
  Settings,
  X,
} from "lucide-react";

export const chatStatus: Record<string, string> = {
  queued: "Queued",
  running: "Working",
  waiting_approval: "Needs your reply",
  waiting_account: "Account needed",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Stopped",
  completed: "Completed",
};

export function SidebarChats({ chats, ...props }: any) {
  return chats.map((chat: any) => (
    <SidebarChat key={chat.id} chat={chat} {...props} />
  ));
}
function SidebarChat({ chat, activeId, onSelect, onManage }: any) {
  const [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(chat.title),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const menu = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (renaming) {
      input.current?.focus();
      input.current?.select();
    }
  }, [renaming]);
  return (
    <div className="chat-row">
      {renaming ? (
        <form
          className="chat-inline-rename"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim() || saving) return;
            setSaving(true);
            setError("");
            try {
              await onManage({ ...chat, title: title.trim() }, "rename");
              setRenaming(false);
            } catch (e: any) {
              setError(e.message);
            } finally {
              setSaving(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !saving) {
              e.preventDefault();
              setRenaming(false);
            }
          }}
        >
          <input
            ref={input}
            aria-label="Chat name"
            value={title}
            maxLength={160}
            disabled={saving}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            className="icon"
            title="Save name"
            aria-label="Save name"
            disabled={saving || !title.trim()}
          >
            <Check size={15} />
          </button>
          <button
            className="icon"
            type="button"
            title="Cancel rename"
            aria-label="Cancel rename"
            disabled={saving}
            onClick={() => setRenaming(false)}
          >
            <X size={15} />
          </button>
          {error && <small role="alert">{error}</small>}
        </form>
      ) : (
        <>
          <button
            className={"chat-link " + (activeId === chat.id ? "selected" : "")}
            aria-current={activeId === chat.id ? "page" : undefined}
            onClick={() => onSelect(chat.id)}
            title={
              chat.title + (chat.state ? " · " + chatStatus[chat.state] : "")
            }
          >
            <MessageSquare size={16} />
            <span className="chat-caption">
              <span>{chat.title}</span>
              <small
                className="chat-description"
                title={`${chat.provider === "codex" ? "Codex" : "Claude Code"} · ${modelLabel(chat)}`}
              >
                <span className={"chat-agent " + chat.provider}>
                  {chat.provider === "codex" ? "Codex" : "Claude"}
                </span>
                <span aria-hidden="true">·</span>
                <span className="chat-model">{modelLabel(chat)}</span>
              </small>
            </span>
            {[
              "running",
              "queued",
              "waiting_approval",
              "waiting_account",
              "failed",
              "interrupted",
            ].includes(chat.state) && (
              <span
                className={"chat-state " + chat.state}
                aria-label={chatStatus[chat.state]}
              >
                {chat.state === "running"
                  ? "Working"
                  : chat.state === "queued"
                    ? "Queued"
                    : "!"}
              </span>
            )}
          </button>
          <button
            className="icon chat-actions"
            title="Chat actions"
            aria-label={"Actions for " + chat.title}
            aria-controls={menuId}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setPosition({
                top: Math.max(
                  8,
                  Math.min(rect.bottom + 4, window.innerHeight - 96),
                ),
                left: Math.max(
                  8,
                  Math.min(rect.right - 160, window.innerWidth - 168),
                ),
              });
              menu.current?.togglePopover();
            }}
          >
            <MoreHorizontal size={17} />
          </button>
          <div
            ref={menu}
            id={menuId}
            popover="auto"
            className="chat-action-menu"
            style={position}
            aria-label={"Actions for " + chat.title}
          >
            <button
              onClick={() => {
                menu.current?.hidePopover();
                setTitle(chat.title);
                setError("");
                setRenaming(true);
              }}
            >
              <Pencil size={15} />
              Rename
            </button>
            <button
              className="delete-action"
              onClick={() => {
                menu.current?.hidePopover();
                onManage(chat, "delete");
              }}
            >
              <Trash2 size={15} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function SidebarNavigation({
  accounts,
  onRefreshAccounts,
  projects,
  chats,
  chatId,
  projectId,
  query,
  results,
  searching,
  searchError,
  onQuery,
  onChat,
  onManage,
  onProject,
  onHome,
  onNew,
  onAddProject,
  onProjectSettings,
}: any) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (projectId) setExpanded((old) => ({ ...old, [projectId]: true }));
  }, [projectId, chatId]);
  return (
    <>
      <button className="new-chat" onClick={() => onNew(projectId)}>
        <Plus size={18} />
        New chat
      </button>
      <div className="search">
        <Search size={17} />
        <input
          aria-label="Search chats"
          placeholder="Search all chats"
          maxLength={200}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        {query && (
          <button
            className="icon"
            aria-label="Clear search"
            onClick={() => onQuery("")}
          >
            <X size={16} />
          </button>
        )}
      </div>
      <nav className="sidebar-navigation" aria-label="Projects and chats">
        {query.trim() ? (
          <>
            <div className="sidebar-section">
              <span>Search results</span>
            </div>
            {searching && (
              <p className="side-hint" role="status">
                Searching…
              </p>
            )}
            {searchError && (
              <p className="side-hint" role="alert">
                {searchError}
              </p>
            )}
            {!searching && !results.length && (
              <p className="side-hint">
                No chats found. Try another title or a word from a message.
              </p>
            )}
            {results.map((chat: any) => (
              <div key={chat.id} className="search-result">
                <SidebarChats
                  chats={[chat]}
                  activeId={chatId}
                  onSelect={onChat}
                  onManage={onManage}
                />
                <small>
                  {projects.find((p: any) => p.id === chat.project_id)?.name ||
                    "Personal chats"}
                </small>
              </div>
            ))}
          </>
        ) : (
          <>
            <button
              className={
                "home-link " + (!chatId && !projectId ? "selected" : "")
              }
              onClick={onHome}
            >
              <Home size={17} />
              Home
            </button>
            <div className="sidebar-section">
              <span>Projects</span>
              <button
                className="icon"
                aria-label="Add project"
                title="Add project"
                onClick={onAddProject}
              >
                <Plus size={17} />
              </button>
            </div>
            {projects.map((project: any) => {
              const projectChats = chats.filter(
                (c: any) => c.project_id === project.id,
              );
              const open = expanded[project.id] ?? project.id === projectId;
              return (
                <section
                  key={project.id}
                  className={
                    "project-group " +
                    (projectId === project.id ? "current" : "")
                  }
                  aria-label={project.name}
                >
                  <div className="project-heading">
                    <button
                      className="icon project-toggle"
                      aria-expanded={open}
                      aria-controls={"project-chats-" + project.id}
                      aria-label={
                        (open ? "Collapse " : "Expand ") + project.name
                      }
                      onClick={() =>
                        setExpanded((old) => ({ ...old, [project.id]: !open }))
                      }
                    >
                      {open ? (
                        <ChevronDown size={16} />
                      ) : (
                        <ChevronRight size={16} />
                      )}
                    </button>
                    <button
                      className="project-name"
                      onClick={() => onProject(project.id)}
                      title={project.name}
                    >
                      <FolderGit2 size={17} />
                      <span>{project.name}</span>
                      <small>{projectChats.length}</small>
                    </button>
                    <button
                      className="icon project-add"
                      aria-label={"New chat in " + project.name}
                      title="New chat"
                      onClick={() => onNew(project.id)}
                    >
                      <Plus size={15} />
                    </button>
                    <button
                      className="icon"
                      title="Project settings"
                      aria-label={"Settings for " + project.name}
                      onClick={() => onProjectSettings(project)}
                    >
                      <Settings size={15} />
                    </button>
                  </div>
                  <div
                    className="project-chats"
                    id={"project-chats-" + project.id}
                    hidden={!open}
                  >
                    <SidebarChats
                      chats={projectChats}
                      activeId={chatId}
                      onSelect={onChat}
                      onManage={onManage}
                    />
                  </div>
                </section>
              );
            })}
            {!projects.length && (
              <button className="empty-link" onClick={onAddProject}>
                <Plus size={16} />
                Add a project
              </button>
            )}
            <div className="sidebar-section">
              <span>Personal chats</span>
              <button
                className="icon"
                aria-label="New personal chat"
                onClick={() => onNew(null)}
              >
                <Plus size={17} />
              </button>
            </div>
            <SidebarChats
              chats={chats.filter((c: any) => !c.project_id)}
              activeId={chatId}
              onSelect={onChat}
              onManage={onManage}
            />
          </>
        )}
        {!!accounts?.length && (
          <details className="sidebar-usage" open>
            <summary>Account limits</summary>
            {accounts.map((a: any) => (
              <AccountUsage
                key={a.id}
                account={a}
                refresh={onRefreshAccounts}
                compact
                sidebar
              />
            ))}
          </details>
        )}
      </nav>
    </>
  );
}
