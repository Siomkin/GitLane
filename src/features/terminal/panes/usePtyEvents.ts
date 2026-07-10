// PTY event transport (GL-177): the one pair of Tauri event subscriptions that
// routes backend pty-data/pty-exit into the pane controller. Mounted once for
// the app session; the unlisten handles resolve asynchronously, so cleanup
// chains through them — no listener outlives the panes it feeds.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { PtyDataEvent, PtyExitEvent } from "@/lib/api";
import type { PaneController } from "./paneController";

export function usePtyEvents(controller: PaneController): void {
  useEffect(() => {
    const unlistenData = listen<PtyDataEvent>("pty-data", (event) => {
      controller.routeData(event.payload.sessionId, event.payload.data);
    });
    const unlistenExit = listen<PtyExitEvent>("pty-exit", (event) => {
      controller.routeExit(event.payload.sessionId);
    });
    return () => {
      void unlistenData.then((f) => f());
      void unlistenExit.then((f) => f());
    };
  }, [controller]);
}
