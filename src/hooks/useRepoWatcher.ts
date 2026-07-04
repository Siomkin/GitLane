import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useRepo } from "@/store/repo";
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

  // Live filesystem watching, routed by the event's open path (one watcher
  // per open tab). The active repo re-syncs: ordinary worktree/index events
  // only need status; any graph-affecting event upgrades the whole debounce
  // burst to a full sync. A background tab's event only re-probes its tab
  // label (branch) — activation does a full load anyway. One-shot getState
  // reads, so the listener never re-subscribes on store churn.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingScope: RefreshScope | null = null;
    const tabTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unlisten = listen<RepoChangedEvent>("repo-changed", ({ payload }) => {
      const { summary, openPaths, refreshTabInfo } = useRepo.getState();
      if (summary?.path === payload.path) {
        pendingScope = mergeRefreshScope(pendingScope, payload.kind);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const scope = pendingScope ?? "all";
          pendingScope = null;
          void refresh({ prs: false, quiet: true, scope });
        }, 400);
        return;
      }
      // A background tab: debounce per path — a burst (rebase, bun install)
      // collapses into one probe.
      if (!openPaths.includes(payload.path)) return;
      const previous = tabTimers.get(payload.path);
      if (previous) clearTimeout(previous);
      tabTimers.set(
        payload.path,
        setTimeout(() => {
          tabTimers.delete(payload.path);
          void refreshTabInfo(payload.path);
        }, 400),
      );
    }).catch(() => () => {});
    return () => {
      if (timer) clearTimeout(timer);
      for (const pending of tabTimers.values()) clearTimeout(pending);
      void unlisten.then((off) => off());
    };
  }, [refresh]);
}
