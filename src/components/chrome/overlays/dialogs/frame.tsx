import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Shared modal shell for the small store-driven dialogs (create-branch /
 * confirm / prompt): the dimmed blurred backdrop, the popped panel, and the
 * dismiss wiring — a backdrop click dismisses, clicks inside the panel are
 * stopped so they never reach the backdrop. Escape handling intentionally stays
 * with each dialog (input-level vs window-level) — the frame owns only the
 * chrome. Domain-free, but scoped to overlays/ rather than components/ui. */
export function ModalFrame({
  z,
  panelClassName = "w-[420px]",
  onDismiss,
  children,
}: {
  /** Stacking layer, spelled as a literal class so Tailwind keeps it:
   * create-branch sits at z-[60]; confirm/prompt sit above it at z-[80] so a
   * confirmation opened from another overlay always wins. */
  z: "z-[60]" | "z-[80]";
  /** Panel width (default the standard 420px dialog). */
  panelClassName?: string;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("fixed inset-0 grid place-items-center bg-black/30 backdrop-blur-sm", z)}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "rounded-2xl border border-black/10 bg-white p-[22px] shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] dark:border-white/10 dark:bg-neutral-800",
          panelClassName,
        )}
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-100">{children}</div>
  );
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return <div className="mt-[18px] flex justify-end gap-2">{children}</div>;
}

export function DialogCancelButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
    >
      Cancel
    </button>
  );
}

export function DialogPrimaryButton({
  onClick,
  disabled,
  danger,
  autoFocus,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Destructive styling (rose) — used by danger confirms. */
  danger?: boolean;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      autoFocus={autoFocus}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-9 rounded-lg px-4 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45",
        danger ? "bg-rose-500" : "bg-[var(--accent)]",
      )}
    >
      {children}
    </button>
  );
}

/** Inline validation message under a dialog's input. */
export function DialogValidationError({ children }: { children: ReactNode }) {
  return <div className="mt-2 text-[12px] text-rose-500">{children}</div>;
}
