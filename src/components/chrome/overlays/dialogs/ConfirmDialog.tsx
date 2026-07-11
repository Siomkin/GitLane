import { useEffect } from "react";
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
    <ModalFrame z="z-[80]" onDismiss={closeConfirm}>
      <DialogTitle>{confirm.title}</DialogTitle>
      {confirm.message && (
        <div className="mt-2 text-[12.5px] leading-relaxed text-neutral-400">{confirm.message}</div>
      )}
      {confirm.details && confirm.details.length > 0 && (
        <div className="mt-3 rounded-xl border border-black/10 bg-black/[0.025] p-3 text-[12px] leading-relaxed text-neutral-600 dark:border-white/10 dark:bg-white/[0.035] dark:text-neutral-300">
          {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
          {confirm.details.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      {confirm.warnings && confirm.warnings.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
          {/* Snapshot text has no identity and never reorders while this modal is mounted. */}
          {confirm.warnings.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}
      <DialogFooter>
        <DialogCancelButton onClick={closeConfirm} />
        <DialogPrimaryButton autoFocus onClick={accept} danger={confirm.danger}>
          {confirm.confirmLabel ?? "Confirm"}
        </DialogPrimaryButton>
      </DialogFooter>
    </ModalFrame>
  );
}
