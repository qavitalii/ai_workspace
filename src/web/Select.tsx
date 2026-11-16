import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";

type Choice = { value: string; label: string; disabled: boolean };
type Props = {
  children: ReactNode;
  "aria-label": string;
  name?: string;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  required?: boolean;
  onChange?: (event: { target: { value: string } }) => void;
};
function text(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : String(child),
    )
    .join("");
}
function choicesFrom(children: ReactNode): Choice[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{
        children?: ReactNode;
        value?: string;
        disabled?: boolean;
      }>(child)
    )
      return [];
    if (child.type === Fragment) return choicesFrom(child.props.children);
    const label = text(child.props.children);
    return [
      {
        value: String(child.props.value ?? label),
        label,
        disabled: !!child.props.disabled,
      },
    ];
  });
}

/** Styled single selection, including form values and keyboard navigation. */
export function Select({
  children,
  "aria-label": label,
  name,
  value,
  defaultValue,
  disabled,
  required,
  onChange,
}: Props) {
  const choices = choicesFrom(children);
  const initial = defaultValue ?? choices.find((c) => !c.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = useState(initial);
  const selected = value ?? internalValue;
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState("");
  const [host, setHost] = useState<Element | null>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null),
    field = useRef<HTMLInputElement>(null);
  const id = useId();
  const typeahead = useRef({ text: "", time: 0 });
  const searchable = choices.length > 7;
  const filtered = choices.filter((c) =>
    c.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const enabled = filtered.filter((c) => !c.disabled);
  const current = choices.find((c) => c.value === selected);
  const activeIndex = filtered.findIndex((c) => c.value === active);
  const optionId = (index: number) => `${id}-option-${index}`;

  useLayoutEffect(() => {
    setHost(trigger.current?.closest("dialog") || document.body);
  }, []);
  useEffect(() => {
    const form = field.current?.form;
    const reset = () => {
      setInternalValue(initial);
      panel.current?.hidePopover();
    };
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [initial]);
  useEffect(() => {
    if (open && !enabled.some((c) => c.value === active))
      setActive(enabled[0]?.value ?? "");
  }, [open, query, children]);
  useEffect(() => {
    if (open && activeIndex >= 0)
      document
        .getElementById(optionId(activeIndex))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);
  useEffect(() => {
    if (disabled) panel.current?.hidePopover();
  }, [disabled]);

  function position() {
    const button = trigger.current,
      popup = panel.current;
    if (!button || !popup) return;
    const rect = button.getBoundingClientRect(),
      viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0,
      height = viewport?.height ?? window.innerHeight;
    const width = Math.min(Math.max(rect.width, 220), window.innerWidth - 16);
    const below = top + height - rect.bottom - 12,
      above = rect.top - top - 12;
    const upwards = below < 220 && above > below;
    const available = Math.max(80, upwards ? above : below);
    popup.style.width = `${width}px`;
    popup.style.maxHeight = `${Math.min(340, available)}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    popup.style.top = `${upwards ? Math.max(top + 8, rect.top - popup.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
  }
  useLayoutEffect(() => {
    if (open) position();
  }, [open, query, children]);
  useEffect(() => {
    if (!open) return;
    const update = () => position();
    const scroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) update();
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, [open]);

  function close(focus = true) {
    panel.current?.hidePopover();
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  function show(firstQuery = "", last = false) {
    if (trigger.current?.matches(":disabled")) return;
    setQuery(firstQuery);
    const matches = choices.filter(
      (c) =>
        !c.disabled &&
        c.label.toLocaleLowerCase().includes(firstQuery.toLocaleLowerCase()),
    );
    setActive(
      last
        ? (matches.at(-1)?.value ?? "")
        : (matches.find((c) => c.value === selected)?.value ??
            matches[0]?.value ??
            ""),
    );
    panel.current?.showPopover();
    setOpen(true);
    position();
    if (searchable) search.current?.focus();
  }
  function choose(choice: Choice) {
    if (choice.disabled || trigger.current?.matches(":disabled")) return;
    // Use the native setter so React also notifies the enclosing form.
    if (field.current) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(field.current, choice.value);
      field.current.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setInternalValue(choice.value);
    onChange?.({ target: { value: choice.value } });
    close();
  }
  function keyboard(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab" && open) {
      close();
      return;
    }
    if (["ArrowDown", "ArrowUp"].includes(e.key)) {
      e.preventDefault();
      if (!open) {
        show("", e.key === "ArrowUp");
        return;
      }
      const index = enabled.findIndex((c) => c.value === active);
      setActive(
        enabled[
          (index + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) %
            enabled.length
        ]?.value ?? "",
      );
      return;
    }
    if (
      open &&
      ["Home", "End"].includes(e.key) &&
      e.target !== search.current
    ) {
      e.preventDefault();
      setActive((e.key === "Home" ? enabled[0] : enabled.at(-1))?.value ?? "");
      return;
    }
    if (e.key === "Enter" || (e.key === " " && e.target !== search.current)) {
      e.preventDefault();
      if (!open) show();
      else {
        const choice = enabled.find((c) => c.value === active);
        if (choice) choose(choice);
      }
      return;
    }
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      e.target !== search.current
    ) {
      e.preventDefault();
      if (searchable) {
        show(e.key);
        return;
      }
      const now = Date.now();
      typeahead.current = {
        text:
          (now - typeahead.current.time < 600 ? typeahead.current.text : "") +
          e.key.toLocaleLowerCase(),
        time: now,
      };
      const match = choices.find(
        (c) =>
          !c.disabled &&
          c.label.toLocaleLowerCase().startsWith(typeahead.current.text),
      );
      if (!open) show();
      if (match) setActive(match.value);
    }
  }
  return (
    <span className="custom-select">
      <input
        ref={field}
        className="select-form-value"
        name={name}
        value={selected}
        onChange={() => {}}
        tabIndex={-1}
        aria-hidden="true"
        required={required}
        disabled={disabled}
        onInvalid={(e) => {
          e.preventDefault();
          trigger.current?.focus();
          show();
        }}
      />
      <button
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          open && !searchable && activeIndex >= 0
            ? optionId(activeIndex)
            : undefined
        }
        aria-required={required}
        disabled={disabled}
        onKeyDown={keyboard}
        onClick={() => (open ? close() : show())}
      >
        <span>{current?.label || "Choose an option"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {host &&
        createPortal(
          <div
            ref={panel}
            popover="auto"
            className="select-popover"
            onKeyDown={keyboard}
            onToggle={(e) => {
              const isOpen = (e.nativeEvent as ToggleEvent).newState === "open";
              setOpen(isOpen);
              if (!isOpen) setQuery("");
            }}
          >
            {searchable && (
              <div className="select-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={search}
                  value={query}
                  aria-label={`Search ${label.toLowerCase()}`}
                  role="combobox"
                  aria-expanded={open}
                  aria-controls={`${id}-list`}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    activeIndex >= 0 ? optionId(activeIndex) : undefined
                  }
                  placeholder="Search…"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            )}
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              className="select-options"
            >
              {filtered.map((choice, index) => (
                <div
                  key={choice.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={choice.value === selected}
                  aria-disabled={choice.disabled || undefined}
                  className={
                    "select-option " + (choice.value === active ? "active" : "")
                  }
                  onPointerMove={() => {
                    if (!choice.disabled) setActive(choice.value);
                  }}
                  onPointerDown={(e) => {
                    if (e.pointerType === "mouse") e.preventDefault();
                  }}
                  onClick={() => choose(choice)}
                >
                  <span>{choice.label}</span>
                  {choice.value === selected && (
                    <Check size={16} aria-hidden="true" />
                  )}
                </div>
              ))}
              {!filtered.length && (
                <div className="select-empty" role="status">
                  No matches
                </div>
              )}
            </div>
          </div>,
          host,
        )}
    </span>
  );
}
