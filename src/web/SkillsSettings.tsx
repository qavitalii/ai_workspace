import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Select } from "./Select";

type SkillInfo = {
  name: string;
  description: string;
  hints: string[];
  fileCount: number;
};
type SavedSkill = SkillInfo & { revision: string };
type Preview = {
  id: string;
  excluded: number;
  skills: (SkillInfo & { conflict: boolean })[];
};
type ConflictAction = "skip" | "replace" | "copy";

export function SkillsSettings({ projectId }: { projectId?: string }) {
  const query = projectId ? "?project=" + projectId : "";
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<SavedSkill[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [choices, setChoices] = useState<Record<string, ConflictAction>>({});
  const [removing, setRemoving] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<SavedSkill[]>("/skills" + query)
      .then((data) => {
        if (live) setSkills(data);
      })
      .catch((error: Error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, [query]);

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function prepare(files: File[], directory: boolean) {
    if (!files.length) return;
    await perform(async () => {
      if (
        directory &&
        (files.length > 500 ||
          files.reduce((sum, f) => sum + f.size, 0) > 20 * 1024 * 1024)
      )
        throw new Error("Choose a folder with up to 500 files and 20 MB.");
      const body = new FormData();
      for (const file of files)
        body.append(
          directory
            ? "path:" + encodeURIComponent(file.webkitRelativePath)
            : "archive",
          file,
        );
      const res = await fetch("/api/skills/preview" + query, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.error || "The skill files could not be read.");
      setChoices({});
      setPreview(data);
    });
  }

  async function download() {
    await perform(async () => {
      const params = new URLSearchParams({ names: selected.join(",") });
      if (projectId) params.set("project", projectId);
      const response = await fetch("/api/skills/export?" + params);
      if (!response.ok)
        throw new Error((await response.json()).error || "Export failed.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "workspace-skills.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  const count =
    preview?.skills.filter(
      (skill) =>
        !skill.conflict ||
        (Object.hasOwn(choices, skill.name) && choices[skill.name] !== "skip"),
    ).length ?? 0;

  return (
    <div
      className={
        projectId
          ? "settings-section-body integration-settings"
          : "integration-settings"
      }
    >
      {projectId ? (
        <p className="settings-section-intro">
          Imported skills appear in the <code>$</code> menu for this project,
          including its working copies.
        </p>
      ) : (
        <header className="workspace-settings-heading">
          <h3>Skills</h3>
          <p className="muted">
            Personal skills appear in the <code>$</code> menu in all chats. Use
            project settings to keep a skill within one project.
          </p>
        </header>
      )}
      <section
        className="workspace-settings-card integration-card"
        aria-label="Import skills"
      >
        <header className="settings-card-heading">
          <h4>{preview ? "Review import" : "Import skills"}</h4>
        </header>
        {!preview ? (
          <>
            <p className="settings-section-note">
              Choose a folder or ZIP with <code>SKILL.md</code> and its
              supporting files. Set up any plugin or service access separately.
            </p>
            <details className="help-details">
              <summary>Find local skill folders</summary>
              <p>
                Look in <code>~/.codex/skills</code> or{" "}
                <code>~/.claude/skills</code>. On Mac, press ⌘⇧G in the folder
                picker to enter a path.
              </p>
            </details>
            <input
              ref={zipInput}
              type="file"
              hidden
              accept=".zip,application/zip"
              onChange={(e) => {
                void prepare(Array.from(e.target.files ?? []), false);
                e.target.value = "";
              }}
            />
            <input
              ref={folderInput}
              type="file"
              hidden
              {...{ webkitdirectory: "" }}
              onChange={(e) => {
                void prepare(Array.from(e.target.files ?? []), true);
                e.target.value = "";
              }}
            />
            <div className="integration-actions">
              <button
                className="primary"
                type="button"
                disabled={busy}
                onClick={() => zipInput.current?.click()}
              >
                Choose ZIP
              </button>
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => folderInput.current?.click()}
              >
                Choose folder
              </button>
              {busy && (
                <span className="muted" role="status">
                  Working…
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="settings-section-note">
              Import to {projectId ? "this project" : "your personal library"}.
              {preview.excluded > 0 &&
                " Skipped " +
                  preview.excluded +
                  " local configuration or cache files."}
              {" Review the source files for any secrets before importing."}
            </p>
            <ul className="integration-list">
              {preview.skills.map((skill) => (
                <li key={skill.name}>
                  <SkillDetails skill={skill} />
                  {skill.conflict && (
                    <label className="field integration-conflict">
                      <span>Already exists</span>
                      <Select
                        aria-label={"When " + skill.name + " already exists"}
                        disabled={busy}
                        value={
                          Object.hasOwn(choices, skill.name)
                            ? choices[skill.name]
                            : "skip"
                        }
                        onChange={(e) =>
                          setChoices({
                            ...choices,
                            [skill.name]: e.target.value as ConflictAction,
                          })
                        }
                      >
                        <option value="skip">Skip</option>
                        <option value="replace">Replace</option>
                        <option value="copy">Keep both</option>
                      </Select>
                    </label>
                  )}
                </li>
              ))}
            </ul>
            <div className="settings-card-actions integration-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPreview(undefined);
                  setError("");
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                type="button"
                disabled={busy || !count}
                onClick={() =>
                  void perform(async () => {
                    const result = await api<{
                      skills: SavedSkill[];
                      saved: number;
                    }>("/skills/import" + query, {
                      id: preview.id,
                      conflicts: choices,
                    });
                    setSkills(result.skills);
                    setPreview(undefined);
                    setNotice(
                      result.saved === 1
                        ? "1 skill imported."
                        : result.saved + " skills imported.",
                    );
                  })
                }
              >
                {busy
                  ? "Importing…"
                  : count === 0
                    ? "No skills selected"
                    : "Import " + count + (count === 1 ? " skill" : " skills")}
              </button>
            </div>
          </>
        )}
      </section>

      <section
        className="workspace-settings-card integration-card"
        aria-label="Skill library"
      >
        <header className="settings-card-heading">
          <h4>{projectId ? "Project skills" : "Personal skills"}</h4>
          <span>{skills?.length}</span>
        </header>
        {!skills && !error && (
          <p className="muted" role="status">
            Loading skills…
          </p>
        )}
        {skills?.length === 0 && (
          <p className="settings-section-note">No skills imported yet.</p>
        )}
        {!!skills?.length && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={selected.length === skills.length}
                disabled={busy}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? skills.map((skill) => skill.name) : [],
                  )
                }
              />
              Select all
            </label>
            <ul className="integration-list">
              {skills.map((skill) => (
                <li key={skill.name}>
                  <label className="checkbox integration-skill-name">
                    <input
                      type="checkbox"
                      checked={selected.includes(skill.name)}
                      disabled={busy}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, skill.name]
                            : selected.filter((name) => name !== skill.name),
                        )
                      }
                    />
                    <SkillDetails skill={skill} />
                  </label>
                  {removing === skill.name ? (
                    <div className="integration-actions">
                      <button
                        className="text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => setRemoving("")}
                      >
                        Cancel
                      </button>
                      <button
                        className="secondary"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            const param =
                              (query ? query + "&" : "?") +
                              "revision=" +
                              skill.revision;
                            setSkills(
                              await api(
                                "/skills/" + skill.name + param,
                                undefined,
                                "DELETE",
                              ),
                            );
                            setSelected((names) =>
                              names.filter((name) => name !== skill.name),
                            );
                            setRemoving("");
                            setNotice("Skill removed.");
                          })
                        }
                      >
                        Confirm removal
                      </button>
                    </div>
                  ) : (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      aria-label={"Remove " + skill.name}
                      onClick={() => setRemoving(skill.name)}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div className="settings-card-actions integration-actions">
              <button
                className="secondary"
                type="button"
                disabled={busy || !selected.length}
                onClick={() => void download()}
              >
                Export selected
              </button>
            </div>
          </>
        )}
      </section>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="settings-section-note integration-feedback" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function SkillDetails({ skill }: { skill: SkillInfo }) {
  return (
    <span className="integration-skill-details">
      <strong>{skill.name}</strong>
      <small>
        {skill.fileCount} {skill.fileCount === 1 ? "file" : "files"}
        {skill.description && " · " + skill.description}
      </small>
      {skill.hints.map((hint) => (
        <small key={hint}>{hint}</small>
      ))}
    </span>
  );
}
