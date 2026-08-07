import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useBackdropDismiss } from "@/hooks/useBackdropDismiss";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { CloseIcon } from "@/components/ui/icons";

/** Stacking layers for modal surfaces. Spelled as literal classes so Tailwind's
 * scanner keeps them, and named so a dialog picks a *layer* rather than
 * memorising a magic number:
 * - `Base` — composers opened from the main UI (create-branch, PR, handoff).
 * - `Recovery` — above those, below anything that confirms an action.
 * - `Top` — confirms, prompts and the settings windows, which must always win
 *   (a confirmation raised from another overlay sits on top of it). */
export const DIALOG_LAYER = {
  Base: "z-[60]",
  Recovery: "z-[70]",
  Top: "z-[80]",
} as const;

export type DialogLayer = (typeof DIALOG_LAYER)[keyof typeof DIALOG_LAYER];

/** Panel surface treatments. The standard dialog is a raised white card; the
 * full settings *windows* sit one step back so their inner panels read as
 * content on a page rather than cards on a card. */
export const DIALOG_SURFACE = {
  Panel: "border-black/10 bg-white dark:border-white/10 dark:bg-neutral-800",
  Window: "border-black/10 bg-neutral-100 dark:border-white/10 dark:bg-neutral-900",
} as const;

/** Open dialogs in mount order — the last one owns Escape. Module state: it
 * describes which surface the keyboard is talking to, and nothing renders it. */
const escapeOwners: Array<{ current?: () => void }> = [];

/**
 * Shared modal shell for every dialog in the app: the dimmed blurred backdrop,
 * the popped panel, and the whole modality contract — `role="dialog"` +
 * `aria-modal` + an accessible name, a Tab focus trap (`useFocusTrap`), Escape,
 * and backdrop-click dismissal. Clicks inside the panel are stopped so they
 * never reach the backdrop. Domain-free, but scoped to overlays/ rather than
 * components/ui.
 *
 * The frame owns Escape (GL-350) rather than leaving it to each dialog: three
 * hand-rolled dialogs had drifted out of the contract precisely because
 * adopting the frame still left them writing the parts it didn't cover. A
 * child's `autoFocus` still owns the initial focus target — the trap only
 * cycles Tab.
 */
export function ModalFrame({
  z,
  panelClassName = "w-[420px]",
  surface = DIALOG_SURFACE.Panel,
  bare,
  label,
  labelledBy,
  active = true,
  busy,
  backdropDismiss = true,
  onDismiss,
  children,
}: {
  z: DialogLayer;
  /** Panel size (default the standard 420px dialog). */
  panelClassName?: string;
  /** Panel background/border treatment — see `DIALOG_SURFACE`. */
  surface?: string;
  /** Drop the panel's uniform padding, for a dialog that owns its own
   * header/body/footer bands (they need edge-to-edge separators). */
  bare?: boolean;
  /** Accessible name for the dialog (screen readers announce it on open).
   * Mutually exclusive with `labelledBy`, for a dialog whose visible heading
   * already carries the name. */
  label?: string;
  labelledBy?: string;
  /** False while a *nested* overlay owns focus and dismissal — the settings
   * windows raise confirms/prompts as App-level siblings, and two live traps
   * would fight over focus while one Escape tore down both. */
  active?: boolean;
  /** Marks the panel busy while its content is still resolving. */
  busy?: boolean;
  /** Whether a backdrop click dismisses. Long-running dialogs turn it off
   * mid-run so a stray click can't drop the progress view; Escape and the
   * explicit close button still work. */
  backdropDismiss?: boolean;
  /** Escape and (unless suppressed) a backdrop click. Omit for a dialog with no
   * implicit dismissal at all. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(active, panelRef);
  // Read the callback through a ref so an inline arrow doesn't resubscribe the
  // listener every render (same idiom as `useDismiss`).
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!active) return;
    // Only the most recently opened dialog answers Escape. Without this, moving
    // Escape into the shared frame would make one keypress close a dialog *and*
    // whatever it was raised from — each frame would own an equal window
    // listener, where before only the dialog holding focus reacted.
    escapeOwners.push(dismissRef);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeOwners[escapeOwners.length - 1] !== dismissRef) return;
      dismissRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = escapeOwners.indexOf(dismissRef);
      if (i !== -1) escapeOwners.splice(i, 1);
    };
  }, [active]);
  // Backdrop click is a redundant dismiss convenience; Escape and the dialog's
  // own controls are the keyboard/AT paths, and the focus trap keeps focus off
  // this element. The hook keeps a selection dragged out of an input from
  // reading as a backdrop click. (react-doctor no-static-element-interactions
  // fires here; the native <dialog> ::backdrop that would silence it is
  // unavailable — jsdom can't showModal — so this stays a documented residual.)
  const backdrop = useBackdropDismiss();
  return (
    <div
      className={cn("fixed inset-0 grid place-items-center bg-black/30 backdrop-blur-sm", z)}
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick(active && backdropDismiss ? onDismiss : undefined)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-busy={busy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "rounded-2xl border shadow-[0_40px_80px_-12px_rgba(0,0,0,0.5)] outline-none",
          surface,
          !bare && "p-[22px]",
          panelClassName,
        )}
        style={{ animation: "gp-pop .14s ease-out" }}
      >
        {children}
      </div>
    </div>
  );
}

/** The header band every outcome-reporting dialog opens with: a status badge on
 * the left, a close button on the right. The badge is the caller's (it tracks
 * that dialog's own phase); the close button is identical everywhere. */
export function DialogCloseRow({
  badge,
  onClose,
  closeRef,
  label = "Close dialog",
}: {
  badge?: ReactNode;
  onClose: () => void;
  /** For a dialog that moves focus here when its last footer button goes away. */
  closeRef?: RefObject<HTMLButtonElement | null>;
  label?: string;
}) {
  return (
    <div className="flex items-start justify-between">
      {badge}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={label}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-lg text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-200",
          focusRing,
        )}
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
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

export function DialogCancelButton({
  onClick,
  children = "Cancel",
}: {
  onClick: () => void;
  /** Override the label where "Cancel" would misread — the abort confirm's
   * decline is "Keep resolving", not a cancel of the dialog. */
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-9 rounded-lg px-4 text-[13px] text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
    >
      {children}
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
      type="button"
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
