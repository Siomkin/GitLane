// Shared presentational pieces for the terminal-agent rows: the drag handle,
// the enable switch, the small icon-buttons, and the dragged-card lift. Both the
// compact `AgentRowView` and the expanded `AgentRowEditor` reuse these so the
// two states stay pixel-consistent. Pure props in, callbacks out.

import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

/** The lift a settings card takes while it is being dragged — shared by the
 *  terminal-agent, ACP-agent and AI-action rows. */
export const DRAG_LIFT_STYLE: CSSProperties = {
  opacity: 0.95,
  boxShadow: "0 18px 40px -12px rgba(0,0,0,0.4)",
  position: "relative",
  zIndex: 20,
};
export const DRAG_CARD_CLASS = "border-[var(--accent)]/60 bg-white dark:bg-neutral-800";

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
  title,
}: {
  enabled: boolean;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? `Disable ${label}` : `Enable ${label}`}
      title={title ?? (enabled ? "Shown in terminal panel" : "Hidden from terminal panel")}
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
