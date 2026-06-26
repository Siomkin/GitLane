import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { arrayMove } from "@dnd-kit/helpers";
import { api, type RepoSummary } from "../lib/api";
import { useAccounts } from "./accounts";
import { mergeOperationStatus } from "./operation";
import { usePulls } from "./pulls";
import {
  beginGraphRequest,
  claimOpenIntent,
  deferRefresh,
  graphGenerationIsCurrent,
  openIntentIsCurrent,
  takePendingRefresh,
} from "./repoRequests";
import { persistSession, readLastPath } from "./repoSession";
import { useUi } from "./ui";
import {
  emptyChanges,
  GRAPH_PAGE_SIZE,
  INITIAL_GRAPH_LIMIT,
  type RepoGet,
  type RepoSet,
  type RepoState,
} from "./repoTypes";

export function createRepoLifecycleActions(
  set: RepoSet,
  get: RepoGet,
): Pick<
  RepoState,
  | "pickAndOpen"
  | "loadRepo"
  | "closeRepo"
  | "reorderOpenPaths"
  | "restoreSession"
  | "refresh"
  | "loadMoreHistory"
> {
  // Store-side glue over the pure request-coordination primitives in
  // `repoRequests.ts`: a graph response is "current" only if it owns both the
  // latest graph generation AND the displayed repo path.
  const graphRequestIsCurrent = (generation: number, path: string) =>
    graphGenerationIsCurrent(generation) && get().summary?.path === path;

  // Secondary (non-graph) reads must land on whichever repo is *currently
  // displayed*, not on a specific graph generation. An unrelated "load more" or
  // refresh bumps the graph generation while these are still in flight; tying
  // them to it would silently drop branches/worktrees/stashes/changes for the
  // repo that's still on screen (GL-20 review). Repo identity (the published
  // summary path) is the right guard — a newer open or a close changes it.
  const repoStillDisplayed = (path: string) => get().summary?.path === path;

  // Replay a re-sync deferred while `loading` was held (no-op when none queued).
  const flushPendingRefresh = () => {
    const scope = takePendingRefresh();
    if (scope) void get().refresh({ prs: false, quiet: true, scope });
  };

  return {
    // Native folder picker → open whatever repo lives there.
    pickAndOpen: async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        await get().loadRepo(picked);
      }
    },

    loadRepo: async (path: string) => {
      // Claim the latest open intent before doing anything that can await. A newer
      // pick supersedes this one even if our open resolves later (GL-20 review).
      const intent = claimOpenIntent();

      // Phase 1 — open the repo. This is a cheap libgit2 metadata read and the only
      // step that can fail "this isn't a repo". Crucially it touches NO shared
      // state: it doesn't bump the graph generation or raise the loading flags. So
      // a failed pick (invalid folder) can't supersede an in-flight load for the
      // repo that's still on screen, nor strand its summary over an empty graph —
      // it only surfaces the error, leaving the current repo (and any pending graph
      // request) untouched. See GL-20.
      let summary: RepoSummary;
      try {
        summary = await api.openRepo(path);
      } catch (e) {
        // Only surface the error if this is still the latest pick — a slow failed
        // open must not error over a repo the user has since switched to.
        if (openIntentIsCurrent(intent)) set({ error: String(e) });
        return;
      }
      // A newer pick superseded us while we were opening → drop this stale open so
      // it can't publish over the repo the user landed on.
      if (!openIntentIsCurrent(intent)) return;

      // Phase 2 — commit to the switch. Bump the generation (superseding any
      // in-flight graph request) and, in one atomic commit, publish the new summary,
      // drop the previous repo's graph/refs/changes, and raise the loading +
      // skeleton flags. The bump and this set share a synchronous tick, so no other
      // load can interleave between them.
      const generation = beginGraphRequest();
      const openPaths = get().openPaths.includes(summary.path)
        ? get().openPaths
        : [...get().openPaths, summary.path];
      persistSession(openPaths, summary.path);
      set({
        summary,
        openPaths,
        forge: null,
        graph: null,
        branches: [],
        worktrees: [],
        stashes: [],
        changes: emptyChanges,
        operation: null,
        loading: true,
        graphLoading: true,
        error: null,
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        wipSelected: false,
        revealTarget: null,
        selectedFile: null,
        fileDiff: null,
        commitFiles: [],
        graphLimit: INITIAL_GRAPH_LIMIT,
        loadingMoreHistory: false,
      });

      // Watch the new worktree as soon as the shell swaps — before the graph — so a
      // commit/checkout during the (slow) graph load still triggers a refresh, the
      // watcher never lingers on the previous repo after a switch, and a graph
      // failure below can't leave the now-active repo unwatched (GL-20 review).
      void api.watchRepo(summary.workdir ?? summary.path).catch(() => {});

      // Reset PR state and resolve the new repo's account binding the moment the
      // summary is published — before awaiting the graph — so the ActionBar can't
      // pair the new repo's summary with the previous repo's PRs during a slow graph
      // load, and a graph failure can't strand stale PR state (GL-20 review).
      usePulls.getState().reset();
      // Resolve this repo's bound account so the PR badge load (fired once the
      // forge is known, below) fetches as that account.
      useAccounts.getState().syncRepoAccount(summary.path);

      // Secondary reads don't gate the first paint, so fan them out independently
      // — each fills its slice as it lands rather than waiting behind the graph in
      // one Promise.all. They're guarded by repo identity (not the graph
      // generation) so an unrelated "load more"/refresh can't drop them while
      // they're still in flight; only a superseded or closed repo does.
      //
      // Branches and working changes are *required* state: an empty navigator or a
      // falsely-clean worktree would be wrong, not merely incomplete, so a failure
      // surfaces on the global error bar (matching the pre-fan-out Promise.all,
      // whose rejection aborted the open). Worktrees and stashes stay best-effort —
      // a missing one degrades gracefully to an empty list.
      void api
        .listBranches(summary.path)
        .then((branches) => {
          if (repoStillDisplayed(summary.path)) set({ branches });
        })
        .catch((e) => {
          if (repoStillDisplayed(summary.path)) set({ error: String(e) });
        });
      void api
        .listWorktrees(summary.path)
        .then((worktrees) => {
          if (repoStillDisplayed(summary.path)) set({ worktrees });
        })
        .catch(() => {});
      void api
        .listStashes(summary.path)
        .then((stashes) => {
          if (repoStillDisplayed(summary.path)) set({ stashes });
        })
        .catch(() => {});
      // The forge drives the toolbar provider indicator (which paints early), so
      // load it alongside the other secondary reads rather than behind the graph.
      // Best-effort: a detection failure degrades to "no forge", never the error bar.
      void api
        .repoForge(summary.path)
        .then((forge) => {
          if (repoStillDisplayed(summary.path)) set({ forge });
        })
        .catch(() => {})
        .finally(() => {
          // Fire the quiet PR-badge load only once the forge is known, so the
          // GitHub-only gate in `loadPullRequests` applies on first paint — a
          // non-GitHub / no-remote repo then skips `gh` instead of surfacing a
          // confusing "couldn't resolve a GitHub repository" error. forge is a
          // cheap libgit2 read and PRs don't gate first paint, so the wait is free.
          // The panel isn't shown yet; opening it does its own foreground load.
          if (repoStillDisplayed(summary.path)) {
            void usePulls.getState().loadPullRequests(false, true);
          }
        });
      void api
        .workingChanges(summary.path)
        .then((changes) => {
          if (repoStillDisplayed(summary.path)) set({ changes });
        })
        .catch((e) => {
          if (repoStillDisplayed(summary.path)) set({ error: String(e) });
        });
      // The active operation (merge/rebase/cherry-pick/revert) gates the
      // conflict workspace. Best-effort: a detection failure degrades to "no
      // operation", never the error bar. The union starts fresh (operation was
      // cleared in Phase 2 above).
      void api
        .operationStatus(summary.path)
        .then((status) => {
          if (repoStillDisplayed(summary.path)) {
            set({ operation: mergeOperationStatus(get().operation, status) });
          }
        })
        .catch(() => {});

      // The graph is the heavy one — await it, then paint and pick the initial
      // selection once it lands, clearing the history skeleton.
      try {
        const graph = await api.commitGraph(summary.path, INITIAL_GRAPH_LIMIT);
        if (!graphRequestIsCurrent(generation, summary.path)) return;
        // Honor a selection the user made while the skeleton was up — the branch
        // navigator stays usable during the load, and picking a branch sets the
        // selection + revealTarget to its tip. Phase 2 cleared the selection, so a
        // non-null one here is a deliberate during-load pick; snapping it back to
        // the tip would scroll the graph to their branch while the inspector still
        // showed HEAD (GL-20 review). Its files were already fetched by the pick.
        const priorSelection = get().selectedCommit;
        // Only honor a during-load pick if its commit is actually in the loaded
        // graph window. A branch tip beyond the initial limit isn't in
        // `graph.commits`, so the graph couldn't scroll to it and the inspector
        // would fall back to the tip while `commitFiles` still belonged to the
        // picked SHA — mismatched metadata. Fall back to the tip (and drop the now
        // unreachable reveal) in that case (GL-20 review).
        const honorPrior =
          priorSelection != null && graph.commits.some((c) => c.id === priorSelection);
        // Default to the newest real commit, never a stash node: in-window stashes
        // are interleaved into `graph.commits` by time and a fresh stash sorts above
        // HEAD, so `commits[0]` is often the stash — selecting it would load its
        // files as a commit and mis-render the inspector.
        const selectedCommit = honorPrior
          ? priorSelection
          : graph.commits.find((c) => !c.stash)?.id ?? null;
        set({
          graph,
          selectedCommit,
          selectedCommits: honorPrior ? get().selectedCommits : selectedCommit ? [selectedCommit] : [],
          selectionAnchor: honorPrior ? get().selectionAnchor : selectedCommit,
          ...(honorPrior ? {} : { commitFiles: [], revealTarget: null }),
          graphLimit: INITIAL_GRAPH_LIMIT,
          graphLoading: false,
          loading: false,
        });
        // Commit-file loading is secondary to showing a usable history. Populate
        // the inspector after the graph is visible (only when we defaulted to the
        // tip — a during-load pick fetched its own files), and ignore a stale
        // response if the user switches repository/selection in the meantime.
        if (selectedCommit && !honorPrior) {
          void api
            .commitFiles(summary.path, selectedCommit)
            .then((commitFiles) => {
              if (repoStillDisplayed(summary.path) && get().selectedCommit === selectedCommit) {
                set({ commitFiles });
              }
            })
            .catch(() => {});
        }
        // Replay any watcher/focus re-sync that arrived while this load held `loading`.
        flushPendingRefresh();
      } catch (e) {
        // Only clear the loading flags if this request still owns the active repo —
        // a newer load may have superseded us while the graph was in flight.
        if (!graphRequestIsCurrent(generation, summary.path)) return;
        set({ loading: false, graphLoading: false, error: String(e) });
        flushPendingRefresh();
      }
    },

    // Close a repo tab. If it was the active one, switch to a neighbour, or fall
    // back to the welcome screen when none remain.
    closeRepo: async (path) => {
      const { openPaths, summary } = get();
      const remaining = openPaths.filter((p) => p !== path);
      const wasActive = summary?.path === path;
      if (!wasActive) {
        persistSession(remaining, summary?.path ?? null);
        set({ openPaths: remaining });
        return;
      }
      if (remaining.length === 0) {
        persistSession([], null);
        set({
          openPaths: [],
          summary: null,
          // `forge` keys the provider indicator independently of `summary`, so a
          // leak here would render a stale indicator on the welcome screen.
          forge: null,
          graph: null,
          branches: [],
          worktrees: [],
          changes: emptyChanges,
          operation: null,
          commitFiles: [],
          selectedCommit: null,
          selectedCommits: [],
          selectionAnchor: null,
          revealTarget: null,
          graphLimit: INITIAL_GRAPH_LIMIT,
          // Clear the loading flags: closing the tab orphans any in-flight graph
          // request (its summary-path guard now fails), so it can't clear them
          // itself and `loading` would otherwise stick true (GL-20 review).
          loading: false,
          graphLoading: false,
          loadingMoreHistory: false,
          selectedFile: null,
          fileDiff: null,
        });
        usePulls.getState().reset();
        return;
      }
      const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0];
      // Remove the closing repo's data before the replacement load. If opening
      // the neighbour fails, the UI shows a clean error state rather than keeping
      // a summary whose tab no longer exists.
      set({
        openPaths: remaining,
        summary: null,
        forge: null,
        graph: null,
        branches: [],
        worktrees: [],
        stashes: [],
        changes: emptyChanges,
        operation: null,
        commitFiles: [],
        selectedCommit: null,
        selectedCommits: [],
        selectionAnchor: null,
        revealTarget: null,
        graphLimit: INITIAL_GRAPH_LIMIT,
        // Reset the loading flags before the replacement load: the closing tab's
        // in-flight graph request is now orphaned, and if loadRepo(next) fails at
        // open_repo its phase-1 catch only sets `error`, so these would otherwise
        // stay stuck from the closed tab (GL-20 review).
        loading: false,
        graphLoading: false,
        loadingMoreHistory: false,
        selectedFile: null,
        fileDiff: null,
      });
      persistSession(remaining, next);
      await get().loadRepo(next);
    },

    reorderOpenPaths: (fromIndex, toIndex) => {
      const { openPaths, summary } = get();
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= openPaths.length ||
        toIndex >= openPaths.length
      ) {
        return;
      }

      const next = arrayMove(openPaths, fromIndex, toIndex);
      persistSession(next, summary?.path ?? readLastPath());
      set({ openPaths: next });
    },

    // On launch, reopen the last active repository (tabs are restored from
    // localStorage in the initial state).
    restoreSession: async () => {
      const last = readLastPath();
      if (last) await get().loadRepo(last);
    },

    refresh: async (opts) => {
      const { summary, graphLimit, loading } = get();
      if (!summary) return;
      // A load (or a manual refresh) holds `loading` while a graph is in flight.
      // Don't drop a watcher/focus re-sync that lands in that window — defer it,
      // keeping the most permissive scope, and replay once the blocker clears
      // (GL-20 review). A full re-sync also can't run concurrently here: it would
      // race the in-flight graph fetch and could livelock a slow initial open.
      if (loading) {
        deferRefresh(opts?.scope === "worktree" ? "worktree" : "all");
        return;
      }
      const generation = opts?.scope === "worktree" ? null : beginGraphRequest();
      if (generation !== null) set({ loadingMoreHistory: false });
      if (!opts?.quiet) set({ loading: true, error: null });
      try {
        if (opts?.scope === "worktree") {
          // The operation status rides along with working changes so a watcher
          // event (terminal commit/checkout/rebase step) keeps the conflict
          // workspace truthful. Best-effort — degrade to "no operation".
          const [changes, opStatus] = await Promise.all([
            api.workingChanges(summary.path),
            api.operationStatus(summary.path).catch(() => null),
          ]);
          if (get().summary?.path !== summary.path) return;
          const selectedFile = get().selectedFile;
          const selectedFileGone =
            selectedFile &&
            selectedFile.source !== "commit" &&
            !changes.staged.some((file) => file.path === selectedFile.path) &&
            !changes.unstaged.some((file) => file.path === selectedFile.path);
          const noWip = changes.staged.length === 0 && changes.unstaged.length === 0;
          set({
            changes,
            // Fold in a fresh operation status; on a detection failure, only
            // clear a stale `operation` when no conflicts remain in the worktree
            // (they survive in `changes.conflicted`), so a transient failure
            // mid-resolution doesn't yank the workspace out from under the user.
            operation: opStatus
              ? mergeOperationStatus(get().operation, opStatus)
              : changes.conflicted.length === 0
                ? null
                : get().operation,
            // Only clear the spinner if this call owned it (non-quiet). The quiet
            // watcher path never set it, so it must not clear a concurrent load's.
            ...(opts?.quiet ? {} : { loading: false }),
            ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
            ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
          });
          return;
        }

        const [nextSummary, graph, branches, worktrees, stashes, changes, forge, opStatus] =
          await Promise.all([
            api.openRepo(summary.path),
            api.commitGraph(summary.path, graphLimit),
            api.listBranches(summary.path),
            api.listWorktrees(summary.path).catch(() => []),
            api.listStashes(summary.path).catch(() => []),
            api.workingChanges(summary.path),
            api.repoForge(summary.path).catch(() => null),
            api.operationStatus(summary.path).catch(() => null),
          ]);
        if (generation === null || !graphRequestIsCurrent(generation, summary.path)) {
          // Superseded mid-flight: replay any sync deferred during this refresh's
          // loading window so the coalesced event isn't lost on this bail (GL-20).
          flushPendingRefresh();
          return;
        }
        const currentSelection = get().selectedCommit;
        // Default to the newest real commit, skipping interleaved stash nodes (see
        // loadRepo above).
        const selectedCommit =
          currentSelection && graph.commits.some((commit) => commit.id === currentSelection)
            ? currentSelection
            : graph.commits.find((commit) => !commit.stash)?.id ?? null;
        const commitFiles = selectedCommit ? await api.commitFiles(nextSummary.path, selectedCommit) : [];
        if (!graphRequestIsCurrent(generation, summary.path)) {
          flushPendingRefresh();
          return;
        }
        // Trim the multi-selection to ids that still exist after the refresh —
        // e.g. a reset/rebase can drop the selected commits. Anchor stays if it
        // survives; otherwise it tracks the new focus commit.
        const liveIds = new Set(graph.commits.map((c) => c.id));
        const prevMulti = get().selectedCommits.filter((id) => liveIds.has(id));
        const selectedCommits =
          prevMulti.length > 0
            ? Array.from(new Set(selectedCommit ? [selectedCommit, ...prevMulti] : prevMulti))
            : selectedCommit
              ? [selectedCommit]
              : [];
        const selectionAnchor =
          get().selectionAnchor && liveIds.has(get().selectionAnchor!)
            ? get().selectionAnchor
            : selectedCommit;
        // Drop a selected working-tree file that no longer has changes (e.g. it
        // was committed/discarded outside the app) so the diff pane can't go stale.
        const sel = get().selectedFile;
        const gone =
          sel &&
          sel.source !== "commit" &&
          !changes.staged.some((f) => f.path === sel.path) &&
          !changes.unstaged.some((f) => f.path === sel.path);
        // If the WIP node was selected but there are no more changes, drop it.
        const noWip = changes.staged.length === 0 && changes.unstaged.length === 0;
        set({
          summary: nextSummary,
          forge,
          graph,
          branches,
          worktrees,
          stashes,
          changes,
          // See the worktree-scope path above: clear a stale `operation` on a
          // detection failure only when no conflicts remain.
          operation: opStatus
            ? mergeOperationStatus(get().operation, opStatus)
            : changes.conflicted.length === 0
              ? null
              : get().operation,
          selectedCommit,
          selectedCommits,
          selectionAnchor,
          commitFiles,
          loading: false,
          // A refresh can supersede the initial open's graph request (e.g. a
          // checkout from the navigator while the skeleton is still up). When it
          // does, that orphaned load returns without clearing graphLoading, so
          // this owning refresh must clear it or the skeleton sticks (GL-20 review).
          graphLoading: false,
          ...(gone ? { selectedFile: null, fileDiff: null } : {}),
          ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
        });
        if (opts?.prs !== false) void usePulls.getState().loadPullRequests(false, true);
        // A non-quiet refresh held `loading`; replay anything deferred during it.
        flushPendingRefresh();
      } catch (e) {
        if (generation !== null && !graphRequestIsCurrent(generation, summary.path)) {
          flushPendingRefresh();
          return;
        }
        // When this refresh owns the graph request (generation !== null), clear
        // graphLoading too: it may have superseded the initial open, whose
        // orphaned load can't clear the skeleton itself (GL-20 review).
        set({ loading: false, error: String(e), ...(generation !== null ? { graphLoading: false } : {}) });
        flushPendingRefresh();
      }
    },

    loadMoreHistory: async () => {
      const { summary, graph, graphLimit, loading, loadingMoreHistory } = get();
      if (!summary || !graph?.truncated || loading || loadingMoreHistory) return;
      const nextLimit = graphLimit + GRAPH_PAGE_SIZE;
      const generation = beginGraphRequest();
      set({ loadingMoreHistory: true, loading: false });
      try {
        const nextGraph = await api.commitGraph(summary.path, nextLimit);
        if (!graphRequestIsCurrent(generation, summary.path)) return;
        set({
          graph: nextGraph,
          graphLimit: nextLimit,
          loadingMoreHistory: false,
        });
      } catch (error) {
        if (!graphRequestIsCurrent(generation, summary.path)) return;
        set({ loadingMoreHistory: false });
        useUi.getState().showToast(String(error), "error");
      }
    },
  };
}
