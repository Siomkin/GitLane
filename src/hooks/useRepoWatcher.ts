import { useEffect } from "react";
import { useRepo } from "@/store/repo";
import { normalizeWatchPath } from "@/lib/paths";
import { listenTyped, REPO_CHANGED, repoChangedEventSchema } from "@/lib/api";
import { mergeRefreshScope, type RefreshScope } from "./repoWatcher";

type RefreshFn = (opts?: {
  prs?: boolean;
  quiet?: boolean;
  scope?: RefreshScope;
}) => Promise<unknown> | void;

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
      timer = setTimeout(() => {
        void refresh({ prs: false, quiet: true });
        // Coming back to the window is the one moment that's real evidence a
        // *sibling* worktree moved — the user was plausibly just working in one.
        // The watcher can't see them (it watches only the open worktree), so
        // this is what keeps the graph's dirty dots honest.
        useRepo.getState().refreshWorktreeDirty();
      }, 150);
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
  // burst to a full sync. A background tab's graph-kind event re-probes just
  // its tab label (branch) — activation does a full load anyway. One-shot
  // getState reads, so the listener never re-subscribes on store churn.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingScope: RefreshScope | null = null;
    const tabTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unlisten = listenTyped(REPO_CHANGED, repoChangedEventSchema, (payload) => {
      const { summary, openPaths, refreshTabInfo } = useRepo.getState();
      // Route on a normalized path so a trailing-separator (or otherwise
      // slightly different) representation can't silently drop the tab's events
      // (GL-125). Downstream still uses the tab's own `openPaths` string.
      const eventPath = normalizeWatchPath(payload.path);
      if (summary && normalizeWatchPath(summary.path) === eventPath) {
        pendingScope = mergeRefreshScope(pendingScope, payload.kind);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const scope = pendingScope ?? "all";
          pendingScope = null;
          void refresh({ prs: false, quiet: true, scope });
        }, 400);
        return;
      }
      // A background tab: its label (branch / worktree parent) only moves when
      // HEAD or refs do — a graph-kind event. Worktree-only churn (file edits,
      // index writes, a background `bun install`) never changes the label, so
      // skip the probe rather than spend a `recents_status` IPC on it (GL-116
      // review). Debounce per path — a graph burst (rebase) collapses to one.
      const tabPath = openPaths.find((p) => normalizeWatchPath(p) === eventPath);
      if (!tabPath) return;
      if (payload.kind !== "graph") return;
      const previous = tabTimers.get(tabPath);
      if (previous) clearTimeout(previous);
      tabTimers.set(
        tabPath,
        setTimeout(() => {
          tabTimers.delete(tabPath);
          void refreshTabInfo(tabPath);
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
