import { useEffect } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useUi } from "@/store/ui";
import {
  DialogCancelButton,
  DialogFooter,
  DialogPrimaryButton,
  DialogTitle,
  ModalFrame,
} from "./frame";

/** In-app confirmation modal for destructive actions (drop stash, delete
 * branch, hard reset). Replaces native `window.confirm`, which is unreliable in
 * the Tauri webview. The triggering action lives in `confirm.onConfirm`. */
export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const closeConfirm = useUi((s) => s.closeConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      // Enter is handled by the autofocused Confirm button's native activation;
      // handling it here too would invoke onConfirm twice.
      if (e.key === "Escape") closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, closeConfirm]);

  if (!confirm) return null;

  const accept = () => {
    confirm.onConfirm();
    closeConfirm();
  };

  return (
    <ModalFrame z="z-[80]" label={confirm.title} onDismiss={closeConfirm}>
      <DialogTitle>{confirm.title}</DialogTitle>
      {confirm.message && (
        <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">{confirm.message}</div>
      )}
      {confirm.details && confirm.details.length > 0 && (
        <div
          // Long file/commit lists must scroll inside the panel instead of pushing
          // the confirm buttons off-screen; the region is focusable so a keyboard
          // user inside the modal's focus trap can still reach the overflow.
          tabIndex={0}
          aria-label="Impact details"
          className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-black/10 bg-black/[0.025] p-3 text-[12px] leading-relaxed text-neutral-600 dark:border-white/10 dark:bg-white/[0.035] dark:text-neutral-300"
        >
          {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
          {confirm.details.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {confirm.warnings && confirm.warnings.length > 0 && (
        <div
          tabIndex={0}
          aria-label="Warnings"
          className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300"
        >
          {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
          {confirm.warnings.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <DialogFooter>
        <DialogCancelButton onClick={closeConfirm} />
        {confirm.secondary && (
          <button
            type="button"
            onClick={() => {
              confirm.secondary!.onClick();
              closeConfirm();
            }}
            className={cn(
              "h-9 rounded-lg border border-black/10 px-4 text-[13px] font-medium text-neutral-700 hover:bg-black/5 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5",
              focusRing,
            )}
          >
            {confirm.secondary.label}
          </button>
        )}
        <DialogPrimaryButton autoFocus onClick={accept} danger={confirm.danger}>
          {confirm.confirmLabel ?? "Confirm"}
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}
