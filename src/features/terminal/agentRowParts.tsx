// Shared presentational pieces for the terminal-agent rows: the drag handle,
// the enable switch, the small icon-buttons, and the inline glyphs. Both the
// compact `AgentRowView` and the expanded `AgentRowEditor` reuse these so the
// two states stay pixel-consistent. Pure props in, callbacks out.

import { cn } from "../../lib/cn";
import { focusRing } from "../../lib/ui";

/** Six-dot reorder grip. In the compact row it reveals on hover *or keyboard
 *  focus* (`revealOnHover`) so tabbing never lands on an invisible control; in
 *  the editor it stays visible. Drag is pointer-driven — see the container. */
export function DragHandle({
  label,
  onPointerDown,
  revealOnHover = false,
  tall = false,
}: {
  label: string;
  onPointerDown: (e: React.PointerEvent) => void;
  revealOnHover?: boolean;
  tall?: boolean;
}) {
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      title="Drag to reorder"
      aria-label={`Drag ${label} to reorder`}
      className={cn(
        "shrink-0 w-5 grid place-items-center rounded-md cursor-grab active:cursor-grabbing text-neutral-300 hover:bg-black/[0.04] hover:text-neutral-500 dark:text-neutral-600 dark:hover:bg-white/[0.06] dark:hover:text-neutral-400 touch-none transition-opacity",
        tall ? "h-8" : "h-7",
        revealOnHover &&
          "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100",
        focusRing,
      )}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5">
        <circle cx="5" cy="3.5" r="1.4" />
        <circle cx="11" cy="3.5" r="1.4" />
        <circle cx="5" cy="8" r="1.4" />
        <circle cx="11" cy="8" r="1.4" />
        <circle cx="5" cy="12.5" r="1.4" />
        <circle cx="11" cy="12.5" r="1.4" />
      </svg>
    </button>
  );
}

/** Show/hide toggle for one agent (mirrors the toolbar visibility). */
export function EnableSwitch({
  enabled,
  label,
  onClick,
}: {
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? `Disable ${label}` : `Enable ${label}`}
      title={enabled ? "Shown in terminal panel" : "Hidden from terminal panel"}
      onClick={onClick}
      className={cn(
        "flex h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
        enabled ? "justify-end bg-[var(--accent)]" : "justify-start bg-black/15 dark:bg-white/20",
        focusRing,
      )}
    >
      <span className="h-4 w-4 rounded-full bg-white shadow-sm" />
    </button>
  );
}

/** A 32px square icon-button (edit / duplicate / delete). `danger` tints the
 *  hover state rose for destructive actions. */
export function RowIconButton({
  label,
  title,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-lg text-neutral-400",
        danger
          ? "hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400"
          : "hover:bg-black/[0.05] hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200",
        focusRing,
      )}
    >
      {children}
    </button>
  );
}

export function EditGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function DuplicateGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

export function DeleteGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
