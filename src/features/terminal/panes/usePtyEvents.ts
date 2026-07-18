// PTY event transport (GL-177): the one pair of Tauri event subscriptions that
// routes backend pty-data/pty-exit into the pane controller. Mounted once for
// the app session; the unlisten handles resolve asynchronously, so cleanup
// chains through them — no listener outlives the panes it feeds.

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PtyDataEvent, PtyExitEvent } from "@/lib/api";
import type { PaneController } from "./paneController";

export function usePtyEvents(controller: PaneController): boolean {
  // Listener registration crosses the Tauri IPC boundary. Do not let pane
  // reconciliation spawn a shell until both subscriptions are installed: a
  // fast shell can print its prompt and exit before either `listen()` promise
  // resolves, permanently dropping that output.
  const [readyController, setReadyController] = useState<PaneController | null>(null);
  useEffect(() => {
    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      controller.routeData(event.payload.sessionId, event.payload.data);
    });
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      controller.routeExit(event.payload.sessionId);
    });
    let active = true;
    void Promise.all([unlistenData, unlistenExit])
      .then(() => {
        if (active) setReadyController(controller);
      })
      .catch(() => {
        // A missing listener keeps readiness false, so no PTY can start with
        // only half of its event transport installed. Tauri reports the
        // registration failure through its own invoke diagnostics.
      });
    return () => {
      active = false;
      void unlistenData.then((f) => f()).catch(() => {});
      void unlistenExit.then((f) => f()).catch(() => {});
    };
  }, [controller]);
  return readyController === controller;
}
