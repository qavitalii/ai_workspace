import { modelLabel } from "../usage";
import {
  Activity,
  ChevronRight,
  FolderGit2,
  MessageSquare,
  Plus,
  Settings,
} from "lucide-react";
import { chatStatus } from "./Sidebar";

export function WorkspaceHome({
  project,
  overview,
  onNew,
  onChat,
  onAccounts,
  onProject,
  onAddProject,
  onSettings,
}: any) {
  const connected = overview.accounts.some((a: any) => a.status === "ready");
  const chats = project
    ? overview.chats.filter((c: any) => c.project_id === project.id)
    : overview.chats.slice(0, 5);
  return (
    <div className="home-scroll">
      <section className="workspace-home">
        <div className="home-heading">
          <div className="home-symbol">
            {project ? <FolderGit2 size={26} /> : <MessageSquare size={26} />}
          </div>
          <h1>{project ? project.name : "What would you like to work on?"}</h1>
          <p>
            {project
              ? project.repo
              : "Work with Codex or Claude Code. Your chats and files are available on every device."}
          </p>
          <div className="home-actions">
            <button
              className="primary"
              onClick={() =>
                connected ? onNew(project?.id || null) : onAccounts()
              }
            >
              <Plus size={18} />
              {connected
                ? project
                  ? "New chat in this project"
                  : "Start a new chat"
                : "Connect your first agent"}
            </button>
            {project && (
              <button className="secondary" onClick={() => onSettings(project)}>
                <Settings size={17} />
                Project settings
              </button>
            )}
          </div>
        </div>
        {!connected && (
          <div className="getting-started">
            <h2>Start with your agent account</h2>
            <p>
              Connect your Codex or Claude Code account, then open a chat and
              describe your task. You can add a GitHub project whenever you need
              one.
            </p>
            <button className="text-button" onClick={onAccounts}>
              <Activity size={16} />
              Open agent accounts
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        {project && (
          <p className="project-context">
            Chats here use this repository and its connected folders. Each chat
            has its own working branch.
          </p>
        )}
        {!project && (
          <section className="home-projects" aria-label="Projects">
            <div className="section-heading">
              <h2>Projects</h2>
              <button className="text-button" onClick={onAddProject}>
                <Plus size={16} />
                Add project
              </button>
            </div>
            {overview.projects.length ? (
              <div className="project-grid">
                {overview.projects.map((p: any) => {
                  const count = overview.chats.filter(
                    (c: any) => c.project_id === p.id,
                  ).length;
                  return (
                    <button
                      className="project-card"
                      key={p.id}
                      onClick={() => onProject(p.id)}
                    >
                      <FolderGit2 size={20} />
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {count} {count === 1 ? "chat" : "chats"} · {p.repo}
                        </small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="empty-description">
                Keep related chats together by connecting a GitHub repository.
              </p>
            )}
          </section>
        )}
        <section aria-label={project ? "Project chats" : "Recent chats"}>
          <div className="section-heading">
            <h2>{project ? "Chats" : "Recent chats"}</h2>
            <span>{project ? chats.length : ""}</span>
          </div>
          {chats.length ? (
            <div className="home-chat-list">
              {chats.map((c: any) => (
                <button key={c.id} onClick={() => onChat(c.id)}>
                  <MessageSquare size={18} />
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.provider === "codex" ? "Codex" : "Claude Code"} ·{" "}
                      {modelLabel(c)} ·{" "}
                      {overview.projects.find((p: any) => p.id === c.project_id)
                        ?.name || "Personal chat"}
                    </small>
                  </span>
                  <small className={"home-chat-status " + (c.state || "")}>
                    {chatStatus[c.state] || "Ready"}
                  </small>
                  <ChevronRight size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-description">
              <p>
                {project
                  ? "Start the first conversation for this project."
                  : "Your conversations will appear here after you create a chat."}
              </p>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
