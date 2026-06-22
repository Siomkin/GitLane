import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  mergeRefreshScope,
  type RefreshScope,
  type RepoChangedEvent,
} from "./repoWatcher";

type RefreshFn = (opts?: {
  prs?: boolean;
  quiet?: boolean;
  scope?: RefreshScope;
}) => Promise<void> | void;

/**
 * Keep the open repo in sync with changes made outside the app:
 *  - re-sync when the window regains focus / becomes visible (a terminal commit,
 *    another tool), and
 *  - re-sync on the backend `repo-changed` filesystem event, debounced 400ms.
 *
 * Both passes are quiet and skip the gh PR fetch so they never flash the UI or
 * spam gh on every alt-tab / file write. `refresh` is the store action, whose
 * identity is stable, so these effects don't re-subscribe on every render.
 */
export function useRepoWatcher(refresh: RefreshFn) {
  // Focus / visibility re-sync. A single alt-tab can fire both `focus` and
  // `visibilitychange`, so a short debounce coalesces them into one refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resync = () => {
      if (document.hidden) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh({ prs: false, quiet: true }), 150);
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [refresh]);

  // Live filesystem watching: ordinary worktree/index events only need status.
  // Any graph-affecting event upgrades the whole debounce burst to a full sync.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingScope: RefreshScope | null = null;
    const unlisten = listen<RepoChangedEvent>("repo-changed", ({ payload }) => {
      pendingScope = mergeRefreshScope(pendingScope, payload.kind);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const scope = pendingScope ?? "all";
        pendingScope = null;
        void refresh({ prs: false, quiet: true, scope });
      }, 400);
    }).catch(() => () => {});
    return () => {
      if (timer) clearTimeout(timer);
      void unlisten.then((off) => off());
    };
  }, [refresh]);
}
