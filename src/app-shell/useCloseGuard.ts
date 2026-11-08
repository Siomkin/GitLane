import { useEffect } from "react";

import { currentWindow } from "@/components/chrome/useWindowMaximized";
import { acknowledgeCloseRequest } from "@/lib/api/events";
import { isTauri } from "@/lib/platform";
import { useRepo } from "@/store/repo";
import { fileViewHoldsDraft } from "@/store/repoFilesActions";
import { useUi } from "@/store/ui";

/** Ask before a window close (or the macOS Quit item, which routes here) drops a
 * dirty draft. Once this listens, Tauri no longer closes the window itself: the
 * API destroys it after the handler unless the event was prevented. */
export const useCloseGuard = () => {
  useEffect(() => {
    if (!isTauri) return;
    const win = currentWindow();
    if (!win) return;
    const destroy = () => void win.destroy();
    const stop = win
      .onCloseRequested((event) => {
        void acknowledgeCloseRequest().catch(() => {});
        try {
          const { fileView, guardDirtyFileView } = useRepo.getState();
          if (!fileViewHoldsDraft(fileView)) return;
          if (fileView?.edit?.saving) {
            // Unlike navigation this can't wait for a retry: a save that never
            // returns would otherwise leave the window impossible to close.
            useUi.getState().requestConfirm({
              title: "This file is still saving",
              message: "Closing now may interrupt the write.",
              confirmLabel: "Close anyway",
              danger: true,
              onConfirm: destroy,
            });
          } else {
            guardDirtyFileView(destroy);
          }
          event.preventDefault();
        } catch (e) {
          // Left unprevented: a broken guard must not trap the user in the window.
          console.error("close guard failed", e);
        }
      })
      .catch((e: unknown) => {
        console.error("close guard not installed", e);
        return () => {};
      });
    return () => void stop.then((unlisten) => unlisten());
  }, []);
};
