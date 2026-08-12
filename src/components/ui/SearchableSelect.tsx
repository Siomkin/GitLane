// A constrained combobox: type to filter a fixed option list, pick one value.
// Used where a native `<select>` is too long to scan (ACP model lists with
// dozens of variants). Free-text commit is deliberately not allowed — the
// value must be one of the options (or the empty sentinel).

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ChevronDownIcon } from "./icons";

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Dimmed annotation (description, effort hint, …). */
  hint?: string;
}

export function SearchableSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "Search…",
  className,
  wrapperClassName,
}: {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
  wrapperClassName?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const rootRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(q) ||
        option.value.toLowerCase().includes(q) ||
        (option.hint ?? "").toLowerCase().includes(q),
    );
  }, [options, query]);

  const safeActive = filtered.length ? Math.min(active, filtered.length - 1) : -1;

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Close on outside click / Escape at the document level so the list does not
  // stay open when focus moves to another field in the same form.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  const display = open ? query : (selected?.label ?? "");

  return (
    <div ref={rootRef} className={cn("relative min-w-0", wrapperClassName)}>
      <input
        value={display}
        onChange={(event) => {
          setQuery(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (filtered.length === 0) return;
            event.preventDefault();
            const down = event.key === "ArrowDown";
            if (!open) setOpen(true);
            setActive((current) => {
              const cur = filtered.length ? Math.min(current, filtered.length - 1) : -1;
              return cur < 0
                ? down
                  ? 0
                  : filtered.length - 1
                : (cur + (down ? 1 : -1) + filtered.length) % filtered.length;
            });
          } else if (event.key === "Enter") {
            if (open && safeActive >= 0 && filtered[safeActive]) {
              event.preventDefault();
              pick(filtered[safeActive].value);
            }
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            setQuery("");
          }
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && safeActive >= 0 ? optionId(safeActive) : undefined}
        aria-label={ariaLabel}
        className={cn(className, "pr-7")}
      />
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400"
      />
      {open && (
        <ul
          role="listbox"
          id={listboxId}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-neutral-900"
        >
          {filtered.length === 0 ? (
            <li className="px-2.5 py-1.5 text-[12px] text-neutral-400">No matches</li>
          ) : (
            filtered.map((option, index) => (
              <li
                key={`${option.value}-${index}`}
                id={optionId(index)}
                role="option"
                aria-selected={option.value === value}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(option.value);
                  }}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px]",
                    index === safeActive
                      ? "bg-[var(--accent-soft)] text-[color:var(--accent)]"
                      : "text-neutral-700 dark:text-neutral-200",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && (
                    <span className="max-w-[40%] shrink-0 truncate text-[11px] text-neutral-400">
                      {option.hint}
                    </span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
