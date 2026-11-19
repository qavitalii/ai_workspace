import { FolderActions } from "./FolderActions";
import { ProjectWorkspaces } from "./ProjectWorkspaces";
import { workspaceLabel } from "./WorkspaceFiles";
import { modelLabel } from "../usage";
import { ProviderIcon } from "./ProviderIcon";
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
  onUpdated,
  onFiles,
}: any) {
  const connected = overview.accounts.some((a: any) => a.status === "ready");
  const chats = project
    ? overview.chats.filter((c: any) => c.project_id === project.id)
    : overview.chats.slice(0, 5);
  return (
    <div className="home-scroll">
      <section
        className={
          "workspace-home " + (project ? "project-home" : "overview-home")
        }
      >
        <div className="home-heading">
          <div className="home-symbol">
            {project ? <FolderGit2 size={26} /> : <MessageSquare size={26} />}
          </div>
          <h1>{project ? project.name : "Your workspace"}</h1>
          <p>
            {project
              ? project.repo || "Files project"
              : "Continue a conversation or start something new."}
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
                  ? "New chat"
                  : "New chat"
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
        <section
          className="home-recent"
          aria-label={project ? "Project chats" : "Recent chats"}
        >
          <div className="section-heading">
            <h2>{project ? "Chats" : "Recent chats"}</h2>
            <span>{project ? chats.length : ""}</span>
          </div>
          {chats.length ? (
            <div className="home-chat-list">
              {chats.map((c: any) => (
                <button key={c.id} onClick={() => onChat(c.id)}>
                  <ProviderIcon provider={c.provider} size={18} />
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {c.provider === "codex" ? "Codex" : "Claude Code"} ·{" "}
                      {modelLabel(c)} ·{" "}
                      {overview.projects.find((p: any) => p.id === c.project_id)
                        ?.name || "Personal chat"}
                    </small>
                  </span>
                  <small
                    className={"home-chat-status " + (c.state || "")}
                    title={workspaceLabel(c)}
                  >
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
        {project && (
          <ProjectWorkspaces
            key={project.id}
            project={project}
            workspaces={overview.workspaces}
            onUpdated={onUpdated}
            onFiles={onFiles}
            onNew={onNew}
            onOpenChat={onChat}
          />
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
                          {count} {count === 1 ? "chat" : "chats"} ·{" "}
                          {p.repo || "Files project"}
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
        {!project && overview.workspaces.some((w: any) => !w.project_id) && (
          <section
            className="project-workspaces personal-folders"
            aria-label="Personal folders"
          >
            <h3>Personal folders</h3>
            <p className="muted">
              Files remain available after deleting their chats.
            </p>
            {overview.workspaces
              .filter((w: any) => !w.project_id)
              .map((w: any) => (
                <div className="working-folder-card" key={w.id}>
                  <div className="workspace-folder-row">
                    <FolderGit2 size={18} />
                    <span>
                      <strong>{w.name}</strong>
                      <small>
                        {
                          overview.chats.filter(
                            (c: any) => c.workspace_id === w.id,
                          ).length
                        }{" "}
                        {overview.chats.filter(
                          (c: any) => c.workspace_id === w.id,
                        ).length === 1
                          ? "chat"
                          : "chats"}
                      </small>
                    </span>
                    <button className="secondary" onClick={() => onFiles(w)}>
                      Files
                    </button>
                    <button
                      className="secondary"
                      aria-label={"New chat in " + w.name}
                      onClick={() => onNew(null, w.id)}
                    >
                      <MessageSquare size={16} /> New chat
                    </button>
                  </div>
                  <FolderActions workspace={w} onUpdated={onUpdated} />
                </div>
              ))}
          </section>
        )}
      </section>
    </div>
  );
}
