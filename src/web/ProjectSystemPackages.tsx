import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { packageNames } from "../runner/package-request";
import type { ProjectPackages } from "../shared";
import { api } from "./api";

const addedDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function PackageError({ message }: { message: string }) {
  return (
    <p className="inline-error" role="alert">
      {message}
    </p>
  );
}

export function ProjectSystemPackages({
  projectId,
  open,
}: {
  projectId: string;
  open: boolean;
}) {
  const url = `/projects/${projectId}/packages`;
  const [data, setData] = useState<ProjectPackages>();
  const [name, setName] = useState("");
  const [pending, setPending] = useState<"load" | "save" | null>(null);
  const [error, setError] = useState<{ message: string; path?: string }>();
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const addField = useRef<HTMLInputElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<{
    origin: HTMLElement;
    neighbors: HTMLButtonElement[];
  } | null>(null);

  const update = useCallback(
    async (
      save?: () => Promise<string>,
      removal?: { origin: HTMLButtonElement; path: string },
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(save ? "save" : "load");
      setError(undefined);
      setNotice("");
      let saved = false;
      try {
        if (save) setNotice(await save());
        saved = true;
        function rememberFocus(control?: HTMLElement) {
          if (!control || document.activeElement !== control) return;
          const buttons = Array.from(
            control
              .closest(".project-package-groups")
              ?.querySelectorAll("button") ?? [],
          );
          const index = buttons.findIndex((button) => button === control);
          restoreFocus.current = {
            origin: control,
            neighbors: [
              ...buttons.slice(index + 1),
              ...buttons.slice(0, index).reverse(),
            ],
          };
        }
        try {
          const snapshot = await api<ProjectPackages>(url);
          rememberFocus(removal?.origin);
          setData(snapshot);
        } catch (error) {
          const focused = document.activeElement;
          if (
            focused instanceof HTMLElement &&
            panel.current?.contains(focused)
          )
            rememberFocus(focused);
          setData(undefined);
          throw error;
        }
      } catch (error) {
        setError({
          message: (error as Error).message,
          path: saved ? undefined : removal?.path,
        });
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [url],
  );

  useEffect(() => {
    if (open) void update();
  }, [open, update]);

  useLayoutEffect(() => {
    const focus = restoreFocus.current;
    restoreFocus.current = null;
    if (
      !open ||
      !focus ||
      focus.origin.isConnected ||
      document.activeElement !== document.body
    )
      return;
    (
      focus.neighbors.find((button) => button.isConnected) ??
      addField.current ??
      retryButton.current
    )?.focus();
  }, [data, open]);

  function addPackage() {
    if (inFlight.current) return;
    const packageName = name.trim();
    if (!packageNames([packageName])) {
      setNotice("");
      setError({
        message: "Enter a Debian package name such as ffmpeg or g++.",
      });
      return;
    }
    void update(async () => {
      await api(url, { name: packageName });
      setName("");
      return `Saved ${packageName}.`;
    });
  }

  function removePackage(
    origin: HTMLButtonElement,
    path: string,
    message: string,
  ) {
    void update(
      async () => {
        await api(url + path, undefined, "DELETE");
        return message;
      },
      { origin, path },
    );
  }

  const groups = new Map<string, ProjectPackages["packages"]>();
  for (const entry of data?.packages ?? []) {
    const group = groups.get(entry.request_id);
    if (group) group.push(entry);
    else groups.set(entry.request_id, [entry]);
  }

  return (
    <div className="settings-section-body integration-settings">
      <section
        className="project-system-packages"
        aria-label="System packages"
        ref={panel}
      >
        <h3 ref={heading} tabIndex={-1}>
          System packages
        </h3>
        {data && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={data.auto_packages}
                aria-disabled={pending !== null}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  void update(async () => {
                    await api(url, { auto_packages: enabled }, "PATCH");
                    return enabled
                      ? "Automatic remembering is on."
                      : "Automatic remembering is off.";
                  });
                }}
              />
              Remember packages installed by agents
            </label>
            <form
              className="integration-form project-package-form"
              onSubmit={(event) => {
                event.preventDefault();
                addPackage();
              }}
            >
              <label className="field">
                <span>Debian package name</span>
                <input
                  ref={addField}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={pending !== null}
                  placeholder="e.g. ffmpeg"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>
              <button
                type="submit"
                className="secondary"
                aria-disabled={pending !== null}
              >
                Add package
              </button>
            </form>
          </>
        )}
        <div className="project-package-feedback" role="status">
          {pending === "save"
            ? "Saving package settings…"
            : pending === "load" || (!data && !error)
              ? "Loading packages…"
              : notice}
        </div>
        {error && !error.path && <PackageError message={error.message} />}
        {!data && error && (
          <button
            type="button"
            className="secondary"
            ref={retryButton}
            onClick={() => {
              heading.current?.focus();
              void update();
            }}
          >
            Retry loading packages
          </button>
        )}
        {data && groups.size === 0 && (
          <p className="settings-section-note">No saved packages.</p>
        )}
        {groups.size > 0 && (
          <ul className="integration-list project-package-groups">
            {Array.from(groups, ([requestId, packages]) => {
              const first = packages[0];
              const groupPath = `/requests/${encodeURIComponent(requestId)}`;
              const source =
                first.source === "owner"
                  ? "Added manually"
                  : first.source_chat_title ||
                    (first.source_chat_id ? "Untitled chat" : "Deleted chat");
              return (
                <li key={requestId}>
                  <div className="project-package-group-heading">
                    <div className="project-package-source">
                      <strong>{source}</strong>
                      <time dateTime={first.added_at}>
                        {addedDate.format(new Date(first.added_at))}
                      </time>
                    </div>
                    {packages.length > 1 && (
                      <button
                        type="button"
                        className="text-button quiet-danger"
                        aria-label={`Remove group from ${source}`}
                        aria-disabled={pending !== null}
                        onClick={(event) =>
                          removePackage(
                            event.currentTarget,
                            groupPath,
                            `Removed ${packages.length} saved packages.`,
                          )
                        }
                      >
                        Remove group
                      </button>
                    )}
                  </div>
                  {error?.path === groupPath && (
                    <PackageError message={error.message} />
                  )}
                  <ul className="project-package-rows">
                    {packages.map((entry) => {
                      const packagePath = `/${encodeURIComponent(entry.name)}`;
                      return (
                        <li key={entry.name}>
                          <div className="project-package-row">
                            <div className="project-package-name">
                              <code>{entry.name}</code>
                              {entry.disabled && (
                                <span className="project-package-failed">
                                  Installation failed
                                </span>
                              )}
                            </div>
                            <button
                              type="button"
                              className="text-button quiet-danger"
                              aria-label={`Remove ${entry.name}`}
                              aria-disabled={pending !== null}
                              onClick={(event) =>
                                removePackage(
                                  event.currentTarget,
                                  packagePath,
                                  `Removed ${entry.name}.`,
                                )
                              }
                            >
                              Remove
                            </button>
                          </div>
                          {error?.path === packagePath && (
                            <PackageError message={error.message} />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
