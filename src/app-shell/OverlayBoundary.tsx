import type { ComponentType } from "react";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { ErrorFallback } from "@/components/ui/ErrorFallback";
import { DIALOG_LAYER, ModalFrame } from "@/components/chrome/overlays/dialogs/frame";
import { useUi } from "@/store/ui";

type UiSnapshot = ReturnType<typeof useUi.getState>;

/** One globally-mounted overlay and how to close it. `close` clears the ui-store
 * flag that keeps the overlay open, and `isOpen` reads that flag; null `close`
 * marks an always-present, non-closable overlay (toasts, tooltip) whose crash
 * is dropped silently. */
export interface OverlayEntry {
  id: string;
  Overlay: ComponentType;
  close: (() => void) | null;
  isOpen?: (s: UiSnapshot) => boolean;
  /** For a non-closable overlay: a hook whose value changes with the overlay's
   * content, so a crashed layer retries on its next update instead of staying
   * empty until reload. */
  useResetKey?: () => unknown;
}

const noResetKey = () => null;

/** Contains one overlay's render crash to that overlay: the rest of the window
 * keeps working, and Close/Escape clear the overlay's open flag before the
 * boundary resets, so reopening it mounts a fresh instance. The flag is also a
 * reset key, so a card whose overlay was closed elsewhere (repo switch, another
 * menu) goes away with it. */
export function OverlayBoundary({ entry }: { entry: OverlayEntry }) {
  const { Overlay, close, isOpen, useResetKey = noResetKey } = entry;
  const open = useUi((s) => isOpen?.(s) ?? true);
  const resetKey = useResetKey();
  return (
    <ErrorBoundary
      resetKeys={[open, resetKey]}
      fallback={({ error, reset }) => {
        if (!close) return null;
        const dismiss = () => {
          close();
          reset();
        };
        return (
          <ModalFrame z={DIALOG_LAYER.Top} label="Something went wrong" onDismiss={dismiss}>
            <ErrorFallback
              message={`Something went wrong in this window.\n${error.message}`}
              onRetry={dismiss}
              retryLabel="Close"
              className="py-4"
            />
          </ModalFrame>
        );
      }}
    >
      <Overlay />
    </ErrorBoundary>
  );
}
