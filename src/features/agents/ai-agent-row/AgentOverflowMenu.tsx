// The row header's "…" actions menu: configure/save, add another profile, copy
// the adapter's install command, remove. Owns its own dismiss listeners.

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { AcpAdapter, AcpAgent } from "@/lib/api";

export function AgentOverflowMenu({
  agent,
  adapter,
  canAddAnother,
  editing,
  dirty,
  onEdit,
  onCollapse,
  onSave,
  onAddAnother,
  onDelete,
}: {
  agent: AcpAgent;
  adapter: AcpAdapter | undefined;
  canAddAnother: boolean;
  editing: boolean;
  dirty: boolean;
  onEdit: () => void;
  onCollapse: () => void;
  onSave: () => void;
  onAddAnother: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const itemCls =
    "w-full rounded-lg px-3 h-9 text-left text-[13px] text-neutral-700 hover:bg-black/[0.05] dark:text-neutral-200 dark:hover:bg-white/[0.07]";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`Actions for ${agent.name.trim() || "agent"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/[0.05] hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-white/10 dark:hover:text-neutral-200",
          focusRing,
        )}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4" aria-hidden>
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-[232px] rounded-xl border border-black/10 bg-white p-1 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.25)] dark:border-white/10 dark:bg-neutral-800 dark:shadow-[0_18px_44px_-8px_rgba(0,0,0,0.6)]"
        >
          <button
            type="button"
            role="menuitem"
            className={itemCls}
            onClick={() => {
              setOpen(false);
              if (!editing) onEdit();
              else if (dirty) onSave();
              else onCollapse();
            }}
          >
            {editing ? (dirty ? "Save" : "Close") : "Configure…"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canAddAnother || !agent.command.trim()}
            title={
              canAddAnother
                ? "Add another agent for the same adapter — how two models stay a click apart"
                : "This adapter offers no model or effort choice, so a second agent would be identical"
            }
            className={cn(itemCls, "disabled:cursor-default disabled:opacity-45")}
            onClick={() => {
              setOpen(false);
              onAddAnother();
            }}
          >
            Add another profile
          </button>
          {adapter?.install ? (
            <button
              type="button"
              role="menuitem"
              className={itemCls}
              onClick={() => {
                void navigator.clipboard?.writeText(adapter.install).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy install command"}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="h-9 w-full rounded-lg px-3 text-left text-[13px] text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
