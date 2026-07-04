import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { arrayMove } from "@dnd-kit/helpers";
import { api, isRepoOpenError, type RepoSummary } from "../lib/api";
import { repoLabel } from "../lib/paths";
import {
  groupedInsertIndex,
  pruneTabInfo,
  type TabInfo,
  tabInfoFromStatus,
  tabInfoFromSummary,
} from "../lib/tabs";
import { repoIdentityKey, trimTrailingSlash } from "../lib/worktrees";
import { useAccounts } from "./accounts";
import { mergeOperationStatus } from "./operation";
import { migrateProfileBindings } from "./profiles";
import { usePulls } from "./pulls";
import {
  beginGraphRequest,
  claimOpenIntent,
  currentOpenIntent,
  deferRefresh,
  graphGenerationIsCurrent,
  openIntentIsCurrent,
  takePendingRefresh,
} from "./repoRequests";
import { reconcileFileDiff } from "./repoFileDiff";
import { loadSelectionUnion } from "./repoSelectionDiff";
import {
  persistRecents,
  persistSession,
  persistTabInfo,
  readLastPath,
  upsertRecent,
} from "./repoSession";
import { useUi } from "./ui";
import {
  emptyChanges,
  GRAPH_PAGE_SIZE,
  INITIAL_GRAPH_LIMIT,
  type MissingRepoState,
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
  | "refreshTabInfo"
  | "refreshRecents"
  | "removeRecent"
  | "locateMissingRepo"
  | "clearRecents"
  | "refresh"
  | "loadMoreHistory"
  | "loadReflog"
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

  // Human text for a failed open/read: the classified `open_repo` rejection
  // carries a readable message (GL-108); everything else stringifies as before.
  const errorText = (e: unknown) => (isRepoOpenError(e) ? e.message : String(e));

  // Did this failure mean the repo's path is gone? The `open_repo` rejection is
  // authoritative; for the other reads (graph/branches/changes reject with
  // plain strings) re-probe with the classified open itself — so a repo that
  // vanishes mid-session (deleted, or its external volume unmounted) is
  // recognized no matter which read fails first, with the exact kind (a folder
  // that merely lost its `.git` is `notARepository`, not `missing`), and the
  // raw libgit2 message never reaches the error bar for that case.
  const wentMissing = async (
    path: string,
    e: unknown,
  ): Promise<MissingRepoState["kind"] | null> => {
    if (isRepoOpenError(e)) return e.kind === "other" ? null : e.kind;
    try {
      await api.openRepo(path);
      return null; // still opens — the failure was something else
    } catch (probeError) {
      return isRepoOpenError(probeError) && probeError.kind !== "other" ? probeError.kind : null;
    }
  };

  // Swap the workspace for the dedicated missing-repo state (GL-108): one
  // atomic publish that clears every slice of the failed (or previously shown)
  // repo — the failure must never be described over another repo's content —
  // keeps/adds the tab so the user can Remove / Locate… / Retry from the
  // screen, and flags the recents entry so the onboarding list agrees without
  // waiting for its next disk probe. The missing tab is also persisted as the
  // *active* one, matching what's on screen — a relaunch restores straight
  // back into this recovery state instead of silently reopening the repo the
  // user had switched away from.
  const enterMissingState = (path: string, kind: MissingRepoState["kind"]) => {
    // Supersede any in-flight graph request; dropping the summary below also
    // fails every summary-path guard, so nothing stale can publish after this.
    beginGraphRequest();
    const openPaths = get().openPaths.includes(path)
      ? get().openPaths
      : [...get().openPaths, path];
    persistSession(openPaths, path);
    const recents = get().recents.map((r) => (r.path === path ? { ...r, missing: true } : r));
    set({
      missingRepo: { path, kind },
      summary: null,
      openPaths,
      recents,
      forge: null,
      graph: null,
      branches: [],
      reflogEntries: [],
      reflogLoading: false,
      reflogError: null,
      worktrees: [],
      stashes: [],
      changes: emptyChanges,
      operation: null,
      operationAdvisory: null,
      commitFiles: [],
      selectionDiff: null,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      wipSelected: false,
      revealTarget: null,
      graphLimit: INITIAL_GRAPH_LIMIT,
      loading: false,
      graphLoading: false,
      loadingMoreHistory: false,
      selectedFile: null,
      fileDiff: null,
      fileHistory: null,
      compare: null,
      error: null,
    });
    // Same repo-bound cleanup as a switch: PR state and any open repo-bound
    // overlay were computed for a repo that is no longer on screen.
    usePulls.getState().reset();
    useUi.getState().closeConfirm();
    useUi.getState().closeRecovery();
    useUi.getState().closePrompt();
  };

  // GL-126 helper: retire a removed worktree's tab (strip + recents + tab info)
  // without touching the active repo. Used when the worktree isn't — or, after
  // the async parent probe, is no longer — the displayed repo: a background tab,
  // a just-clicked dead tab from another repo, or a focus switch that raced the
  // probe. Keeping the current active path is what stops the fallback from
  // hijacking focus back to a repo the user has since navigated away from.
  const retireDeadWorktreeTab = (path: string) => {
    const remaining = get().openPaths.filter((p) => p !== path);
    if (remaining.length === get().openPaths.length) return; // already gone
    const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
    const recents = get().recents.filter((r) => r.path !== path);
    // `summary` is the still-displayed repo here; keep it active (falling back
    // to the persisted last path when a missing-repo tab is the current one).
    persistSession(remaining, get().summary?.path ?? readLastPath());
    persistTabInfo(prunedInfo);
    persistRecents(recents);
    set({ openPaths: remaining, tabInfoByPath: prunedInfo, recents });
  };

  // GL-126: A *linked worktree* whose directory has been removed is a dead end,
  // not a repository to recover. The GL-108 missing-repo screen (Remove / Retry /
  // Locate…) is the right recovery for a moved or deleted standalone repo, but a
  // removed worktree should hand focus back to a usable context instead of
  // stranding on that screen. When the worktree is the repo on screen, drop its
  // tab and switch to a sensible default — its parent/main repo if known and
  // still on disk, else another open tab, else the welcome screen — and never
  // persist the removed worktree as the active selection (so a relaunch doesn't
  // return to it). A worktree that isn't the displayed repo (a background or
  // just-clicked dead tab) is merely retired, leaving the current repo untouched.
  const fallbackFromRemovedWorktree = async (
    path: string,
    info: TabInfo,
    isCurrent: () => boolean,
  ) => {
    // The dead worktree stops being watched whichever branch handles its tab.
    void api.unwatchRepo(path).catch(() => {});

    // Not the repo on screen (e.g. clicking a dead worktree tab while another
    // repo is displayed): just retire its tab and leave the active repo as is.
    if (get().summary?.path !== path) {
      retireDeadWorktreeTab(path);
      return;
    }

    // Fallback order: the parent/main repo (known and available), then the
    // neighbouring open tab, then any remaining tab.
    const deadPath = trimTrailingSlash(path);
    const openIndex = get().openPaths.indexOf(path);
    const parent = info.mainPath ? trimTrailingSlash(info.mainPath) : null;
    let target: string | null = null;
    if (parent && parent !== deadPath) {
      // Match on the normalized path so a trailing-slash spelling still counts
      // as already-open (mirrors tabIdentity/repoIdentityKey).
      const openParent = get().openPaths.find((p) => trimTrailingSlash(p) === parent);
      if (openParent) {
        target = openParent; // already open — trust it
      } else {
        // The presence probe is the one place this awaits, so capture the open
        // intent first and re-check ownership after: a repo switch initiated in
        // that window has claimed a newer intent even though its summary/graph
        // generation haven't published yet, so `summary`/generation guards alone
        // would miss it and the fallback below could steal focus by claiming a
        // still-newer intent via loadRepo. Only switch to the parent if it still
        // resolves on disk (else we'd trade one missing-repo screen for another).
        const entryIntent = currentOpenIntent();
        let exists = false;
        try {
          const [status] = await api.recentsStatus([parent]);
          exists = status?.exists ?? false;
        } catch {
          /* probe failed — fall back to another open tab */
        }
        // A newer operation (the caller's own token) or an in-flight repo switch
        // (open intent) now owns the store: don't mutate shared state or reload —
        // let that operation publish. The dead worktree tab self-heals on its
        // next activation. This is the async-ownership model the store already
        // uses for overlapping opens/refreshes.
        if (!isCurrent() || !openIntentIsCurrent(entryIntent)) return;
        if (exists) target = parent;
      }
    }
    const remaining = get().openPaths.filter((p) => p !== path);
    const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
    // A removed worktree isn't a repo to relocate — drop it from recents too so
    // the onboarding list doesn't offer a dead worktree with a Locate… action.
    const recents = get().recents.filter((r) => r.path !== path);
    if (!target) target = remaining[Math.max(0, openIndex - 1)] ?? remaining[0] ?? null;

    // Supersede any in-flight graph read for the dead worktree; clearing the
    // summary below also fails every summary-path guard, so nothing stale can
    // publish after this.
    beginGraphRequest();

    if (target) {
      // Clear the dead worktree's workspace *before* the async target open, so
      // the gone directory's graph/history isn't left on screen during the
      // handoff (matches closeRepo's neighbour switch); loadRepo then does the
      // full workspace swap and re-guards its own reads.
      persistSession(remaining, target);
      persistTabInfo(prunedInfo);
      persistRecents(recents);
      set({
        openPaths: remaining,
        tabInfoByPath: prunedInfo,
        recents,
        missingRepo: null,
        summary: null,
        graph: null,
        loading: true,
        graphLoading: true,
        error: null,
      });
      await get().loadRepo(target);
      return;
    }

    // Nothing safe to land on (no available parent, no other tab) → the
    // welcome/empty state (mirrors closeRepo's last-tab branch), never the
    // missing-repo screen. `remaining` is empty here.
    persistSession(remaining, null);
    persistTabInfo(prunedInfo);
    persistRecents(recents);
    set({
      openPaths: remaining,
      tabInfoByPath: prunedInfo,
      recents,
      missingRepo: null,
      summary: null,
      forge: null,
      graph: null,
      branches: [],
      reflogEntries: [],
      reflogLoading: false,
      reflogError: null,
      worktrees: [],
      stashes: [],
      changes: emptyChanges,
      operation: null,
      operationAdvisory: null,
      commitFiles: [],
      selectionDiff: null,
      selectedCommit: null,
      selectedCommits: [],
      selectionAnchor: null,
      wipSelected: false,
      revealTarget: null,
      graphLimit: INITIAL_GRAPH_LIMIT,
      loading: false,
      graphLoading: false,
      loadingMoreHistory: false,
      selectedFile: null,
      fileDiff: null,
      fileHistory: null,
      compare: null,
      error: null,
    });
    usePulls.getState().reset();
    useUi.getState().closeConfirm();
    useUi.getState().closeRecovery();
    useUi.getState().closePrompt();
    // Match closeRepo's last-tab branch: a handoff dialog bound to the now-gone
    // worktree must not linger on the welcome screen (GL-42).
    useUi.getState().closeHandoff();
  };

  // Route a vanished path (GL-108 + GL-126). A removed linked worktree falls
  // back to a usable context (its parent repo / another tab / welcome); a moved
  // or deleted standalone repo keeps the dedicated missing-repo recovery screen.
  // Worktree identity comes from the persisted tab info, falling back to the
  // live summary when the vanished path is the active tab — so a stale or absent
  // tab-info entry can't misroute an active worktree onto the missing screen.
  // `isCurrent` is the caller's ownership token (open intent / graph generation /
  // displayed path), re-checked after the fallback's async probe so a repo
  // switch that races the probe wins instead of being clobbered.
  const handleMissing = async (
    path: string,
    kind: MissingRepoState["kind"],
    isCurrent: () => boolean,
  ) => {
    const info = get().tabInfoByPath[path];
    const summary = get().summary;
    const activeIsThisWorktree = summary?.path === path && summary.isWorktree === true;
    if (info?.isWorktree || activeIsThisWorktree) {
      const wtInfo: TabInfo = info?.isWorktree
        ? info
        : {
            isWorktree: true,
            mainPath: info?.mainPath ?? summary?.mainPath ?? null,
            branch: info?.branch ?? summary?.headBranch ?? null,
          };
      await fallbackFromRemovedWorktree(path, wtInfo, isCurrent);
      return;
    }
    enterMissingState(path, kind);
  };

  // Route a failed secondary read for the displayed repo: a vanished path gets
  // the missing-repo state (or the worktree fallback), anything else the global
  // error bar. Re-guarded after the async presence probe so a repo switch in
  // that window wins.
  const surfaceOpenFailure = async (path: string, e: unknown) => {
    const kind = await wentMissing(path, e);
    if (!repoStillDisplayed(path)) return;
    if (kind) await handleMissing(path, kind, () => repoStillDisplayed(path));
    else set({ error: errorText(e) });
  };

  return {
    // Native folder picker → open whatever repo lives there.
    pickAndOpen: async () => {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === "string") {
        await get().loadRepo(picked);
      }
    },

    loadRepo: async (path: string, opts?: { replaceTab?: string }) => {
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
        if (openIntentIsCurrent(intent)) {
          // A vanished path gets the dedicated missing-repo state — tab click,
          // startup restore, and a recents open all funnel through here
          // (GL-108). Other failures keep the GL-20 behavior: error bar only,
          // the current repo untouched.
          const missing = isRepoOpenError(e) && e.kind !== "other" ? e.kind : null;
          if (missing) await handleMissing(path, missing, () => openIntentIsCurrent(intent));
          else set({ error: errorText(e) });
        }
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
      // Tab placement: an already-open path keeps the strip as-is; `replaceTab`
      // switches that tab to the new path in place (the in-place worktree
      // switch — the tab keeps its repository identity, GL-110); otherwise the
      // new tab is inserted right after the last tab of the same repository so
      // worktrees group next to their parent repo instead of appending as an
      // unrelated sibling.
      const prevPaths = get().openPaths;
      let openPaths: string[];
      if (prevPaths.includes(summary.path)) {
        openPaths = prevPaths;
      } else if (opts?.replaceTab && prevPaths.includes(opts.replaceTab)) {
        openPaths = prevPaths.map((p) => (p === opts.replaceTab ? summary.path : p));
      } else {
        const at = groupedInsertIndex(prevPaths, get().tabInfoByPath, repoIdentityKey(summary));
        openPaths = [...prevPaths.slice(0, at), summary.path, ...prevPaths.slice(at)];
      }
      const tabInfoByPath = pruneTabInfo(
        { ...get().tabInfoByPath, [summary.path]: tabInfoFromSummary(summary) },
        openPaths,
      );
      // Record this open in the recents list (most-recent first) so the
      // onboarding screen can offer it without browsing the filesystem again.
      const recents = upsertRecent(get().recents, {
        path: summary.path,
        name: repoLabel(summary.path),
        branch: summary.headBranch,
        lastOpenedAt: Date.now(),
      });
      persistSession(openPaths, summary.path);
      persistTabInfo(tabInfoByPath);
      persistRecents(recents);
      set({
        summary,
        openPaths,
        // A successful open resolves any missing-repo state (e.g. Retry after
        // the volume re-mounted, or Locate… landing on the relocated repo).
        missingRepo: null,
        tabInfoByPath,
        recents,
        forge: null,
        graph: null,
        branches: [],
        reflogEntries: [],
        reflogLoading: false,
        reflogError: null,
        worktrees: [],
        stashes: [],
        changes: emptyChanges,
        operation: null,
        operationAdvisory: null,
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
        // Inspection slices are repo-bound; a switch must not leave an old repo's
        // history/compare view mounted against the new (or null) summary.
        fileHistory: null,
        compare: null,
        selectionDiff: null,
        graphLimit: INITIAL_GRAPH_LIMIT,
        loadingMoreHistory: false,
      });

      // Watch the new worktree as soon as the shell swaps — before the graph — so a
      // commit/checkout during the (slow) graph load still triggers a refresh, and a
      // graph failure below can't leave the now-active repo unwatched (GL-20 review).
      // Keyed by `summary.path` (the openPaths identity): each open tab keeps its
      // own watch, so switching tabs no longer silences the previous repo (GL-116).
      void api.watchRepo(summary.path).catch(() => {});
      // An in-place tab replacement (the GL-110 worktree switch) re-keys the tab
      // from `replaceTab` to `summary.path`. The per-tab watcher map is keyed by
      // path, so the old key would otherwise leak an OS watch + backend thread for
      // the rest of the session — release it once it has truly left the strip and
      // isn't the new key itself (GL-116 review).
      if (
        opts?.replaceTab &&
        opts.replaceTab !== summary.path &&
        !openPaths.includes(opts.replaceTab)
      ) {
        void api.unwatchRepo(opts.replaceTab).catch(() => {});
      }

      // A repo switch invalidates any open repo-bound overlay: a destructive
      // confirm / reflog-recovery dialog (impact + entries computed for the old
      // repo) and any in-flight prompt (e.g. a recovery-branch name carrying an
      // OID from the old repo). Confirming/submitting after the switch would act
      // on the newly-active repo, so close them here. The FS watcher re-syncs via
      // `refresh` (not `loadRepo`), so this never fires on a same-repo change —
      // only a genuine switch. GL-42 review.
      useUi.getState().closeConfirm();
      useUi.getState().closeRecovery();
      useUi.getState().closePrompt();
      // The hand-off dialog is repo-bound too — but its own success path routes
      // through loadRepo(destination), and closing it then would drop the result
      // screen mid-hand-off. Only close it when no move is in flight (GL-105).
      if (!useUi.getState().handoffRunning) useUi.getState().closeHandoff();

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
          if (repoStillDisplayed(summary.path)) void surfaceOpenFailure(summary.path, e);
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
          if (repoStillDisplayed(summary.path)) void surfaceOpenFailure(summary.path, e);
        });
      // The active operation (merge/rebase/cherry-pick/revert) gates the
      // conflict workspace. Best-effort: a detection failure degrades to "no
      // operation", never the error bar. The union starts fresh (operation was
      // cleared in Phase 2 above).
      void api
        .operationStatus(summary.path)
        .then((status) => {
          if (repoStillDisplayed(summary.path)) {
            set({
              operation: mergeOperationStatus(get().operation, status),
              operationAdvisory: status.advisory || null,
            });
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
          // Honoring the prior selection keeps its merged diff (immutable by oid);
          // collapsing to a single default commit drops it.
          ...(honorPrior ? {} : { commitFiles: [], selectionDiff: null, revealTarget: null }),
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
        // The repo can vanish between the open and the (slow) graph read —
        // classify before surfacing so even this window can't show the raw
        // libgit2 message (GL-108). Re-guard after the async probe.
        const missing = await wentMissing(summary.path, e);
        if (!graphRequestIsCurrent(generation, summary.path)) return;
        if (missing)
          await handleMissing(summary.path, missing, () =>
            graphRequestIsCurrent(generation, summary.path),
          );
        else set({ loading: false, graphLoading: false, error: errorText(e) });
        flushPendingRefresh();
      }
    },

    // Close a repo tab. If it was the active one, switch to a neighbour, or fall
    // back to the welcome screen when none remain.
    closeRepo: async (path) => {
      const { openPaths, summary } = get();
      const remaining = openPaths.filter((p) => p !== path);
      // Every open tab holds a filesystem watch (GL-116); closing the tab is
      // what releases it, whichever branch below handles the tab itself.
      void api.unwatchRepo(path).catch(() => {});
      // Closing the missing-repo tab (its X, or Remove on the screen): the repo
      // data was already cleared when the state was entered, so just drop the
      // tab + state and land on a neighbour or the welcome screen (GL-108).
      if (get().missingRepo?.path === path) {
        const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0] ?? null;
        const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
        set({ openPaths: remaining, missingRepo: null, tabInfoByPath: prunedInfo });
        persistSession(remaining, next);
        persistTabInfo(prunedInfo);
        if (next) await get().loadRepo(next);
        return;
      }
      const wasActive = summary?.path === path;
      if (!wasActive) {
        // `summary` can legitimately be null here (a missing-repo tab is the
        // active one) — keep the persisted lastPath rather than wiping it.
        const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
        persistSession(remaining, summary?.path ?? readLastPath());
        persistTabInfo(prunedInfo);
        set({ openPaths: remaining, tabInfoByPath: prunedInfo });
        return;
      }
      if (remaining.length === 0) {
        persistSession([], null);
        persistTabInfo({});
        set({
          openPaths: [],
          tabInfoByPath: {},
          summary: null,
          // `forge` keys the provider indicator independently of `summary`, so a
          // leak here would render a stale indicator on the welcome screen.
          forge: null,
          graph: null,
          branches: [],
          reflogEntries: [],
          reflogLoading: false,
          reflogError: null,
          worktrees: [],
          changes: emptyChanges,
          operation: null,
          operationAdvisory: null,
          commitFiles: [],
          selectionDiff: null,
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
          fileHistory: null,
          compare: null,
        });
        usePulls.getState().reset();
        // Closing the last tab drops to the welcome screen; any open repo-bound
        // overlay (destructive confirm, reflog-recovery dialog, prompt, or
        // hand-off dialog) was bound to the now-closed repo, so clear them too.
        // The switch-to-neighbour branch below routes through `loadRepo`, which
        // already does this. GL-42.
        useUi.getState().closeConfirm();
        useUi.getState().closeRecovery();
        useUi.getState().closePrompt();
        useUi.getState().closeHandoff();
        return;
      }
      const next = remaining[Math.max(0, openPaths.indexOf(path) - 1)] ?? remaining[0];
      // Remove the closing repo's data before the replacement load. If opening
      // the neighbour fails, the UI shows a clean error state rather than keeping
      // a summary whose tab no longer exists.
      set({
        openPaths: remaining,
        tabInfoByPath: pruneTabInfo(get().tabInfoByPath, remaining),
        summary: null,
        forge: null,
        graph: null,
        branches: [],
        reflogEntries: [],
        reflogLoading: false,
        reflogError: null,
        worktrees: [],
        stashes: [],
        changes: emptyChanges,
        operation: null,
        operationAdvisory: null,
        commitFiles: [],
        selectionDiff: null,
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
        fileHistory: null,
        compare: null,
      });
      persistSession(remaining, next);
      persistTabInfo(pruneTabInfo(get().tabInfoByPath, remaining));
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
    // localStorage in the initial state). Before reopening, probe the restored
    // tabs on disk. A since-removed *worktree* tab (e.g. a pruned agent
    // worktree) is dropped instead of restoring dead (GL-109) — worktree-ness
    // comes from the persisted tab info, since the gone path can't answer. A
    // missing *repository* keeps its tab and restores into the GL-108 recovery
    // screen (Retry is a real path for unmounted volumes). Surviving worktree
    // tabs refresh their identity info (parent repo + branch) for
    // labels/grouping before their first activation (GL-110).
    restoreSession: async () => {
      let last = readLastPath();
      const restored = get().openPaths;
      if (restored.length > 0) {
        try {
          const statuses = await api.recentsStatus(restored);
          const byPath = new Map(statuses.map((s) => [s.path, s]));
          const prevInfo = get().tabInfoByPath;
          // Drop only what the probe positively reported gone AND the persisted
          // info knows was a worktree; a path the probe didn't answer for keeps
          // its tab (defensive — a short result must not wipe the strip).
          const openPaths = restored.filter((path) => {
            const status = byPath.get(path);
            return !status || status.exists || !prevInfo[path]?.isWorktree;
          });
          const tabInfoByPath = Object.fromEntries(
            openPaths.map((path) => {
              const status = byPath.get(path);
              // A kept-but-missing repo tab holds on to its last-known info so
              // its label survives until Retry/Locate resolves it.
              const info =
                status?.exists ? tabInfoFromStatus(status) : prevInfo[path];
              return [path, info ?? { isWorktree: false, mainPath: null, branch: null }];
            }),
          );
          // The last-active path may be among the dropped worktrees — heal to
          // the first *live* survivor (falling back to a missing repo tab,
          // which restores into its recovery screen) rather than reopening a
          // gone directory.
          if (last && !openPaths.includes(last)) {
            last =
              openPaths.find((p) => byPath.get(p)?.exists) ?? openPaths[0] ?? null;
          }
          persistSession(openPaths, last);
          persistTabInfo(tabInfoByPath);
          set({ openPaths, tabInfoByPath });
          // Background tabs are never load-ed until activated, so give each
          // surviving live path its watch now (GL-116) — the active one is
          // (re-)watched by loadRepo below; re-inserting the key is harmless.
          for (const path of openPaths) {
            if (path !== last && byPath.get(path)?.exists) {
              void api.watchRepo(path).catch(() => {});
            }
          }
        } catch {
          // Probe failure: keep the restored tabs — a truly dead last path
          // still surfaces through loadRepo's classified open below.
        }
      }
      if (last) await get().loadRepo(last);
    },

    // A background tab's watcher fired: re-probe the path so its tab label
    // (branch, worktree identity) stays live without loading the repo — the
    // full data reload still happens on activation (loadRepo). Best-effort;
    // a probe failure keeps the last-known label.
    refreshTabInfo: async (path) => {
      try {
        const [status] = await api.recentsStatus([path]);
        if (!status?.exists) return;
        // Re-check after the await: the tab may have closed while probing.
        if (!get().openPaths.includes(path)) return;
        const tabInfoByPath = {
          ...get().tabInfoByPath,
          [path]: tabInfoFromStatus(status),
        };
        persistTabInfo(tabInfoByPath);
        set({ tabInfoByPath });
      } catch {
        /* best-effort: keep the existing tab info */
      }
    },

    // Probe each recent's path on disk: flag the ones that no longer resolve as
    // `missing` and refresh their current branch. Best-effort — a probe failure
    // leaves the list untouched. Merged by path so a concurrent open isn't lost.
    refreshRecents: async () => {
      const paths = get().recents.map((r) => r.path);
      if (paths.length === 0) return;
      try {
        const statuses = await api.recentsStatus(paths);
        const byPath = new Map(statuses.map((s) => [s.path, s]));
        const next = get().recents.map((r) => {
          const status = byPath.get(r.path);
          // When present, trust the probed branch (null = detached, clearing a
          // stale label); when missing, keep the last-known branch to display.
          return status
            ? { ...r, missing: !status.exists, branch: status.exists ? status.branch : r.branch }
            : r;
        });
        persistRecents(next);
        set({ recents: next });
      } catch {
        /* best-effort: keep the existing recents on a status probe failure */
      }
    },

    removeRecent: (path) => {
      const next = get().recents.filter((r) => r.path !== path);
      persistRecents(next);
      set({ recents: next });
    },

    // Locate… (GL-108): re-point a dead repository path at its new location.
    // With no argument it acts on the missing-repo tab state; the onboarding
    // "Recent" list passes its stale path explicitly, so both entry points
    // share the probe + per-repo binding migration.
    locateMissingRepo: async (fromPath) => {
      const stalePath = fromPath ?? get().missingRepo?.path;
      if (!stalePath) return;
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      // Probe the pick first (classified open) so a non-repo folder keeps the
      // missing state in place — and so the *normalized* repo path (not the raw
      // picked folder) keys the tab replacement and binding migration.
      let probe: RepoSummary;
      try {
        probe = await api.openRepo(picked);
      } catch (e) {
        useUi.getState().showToast(errorText(e), "error");
        return;
      }
      // The tab flow can be superseded while the picker/probe was up (Retry
      // succeeded, the tab was closed, or another repo opened) — don't rewrite
      // tabs/bindings for it. The recents flow carries its path explicitly.
      if (!fromPath && get().missingRepo?.path !== stalePath) return;
      if (probe.path !== stalePath) {
        // Carry the old path's per-repo bindings — the account ref + cached
        // identity read (accounts) and the applied profile + custom-email
        // overrides (profiles) — so relocating doesn't silently change how the
        // repo authenticates or commits. The repo's own git config moved with
        // the folder; these are the app-side maps keyed by path. Then replace
        // the stale tab in place (keeping its position; a no-op for a recents
        // entry that has no tab) and drop the dead recents entry — the open
        // below records the new location as active.
        useAccounts.getState().migrateRepoBindings(stalePath, probe.path);
        migrateProfileBindings(stalePath, probe.path);
        // The dead path may still hold a watch from before it went missing;
        // its tab is being re-keyed, so release the stale entry (GL-116).
        void api.unwatchRepo(stalePath).catch(() => {});
        const openPaths = get().openPaths.includes(probe.path)
          ? get().openPaths.filter((p) => p !== stalePath)
          : get().openPaths.map((p) => (p === stalePath ? probe.path : p));
        const recents = get().recents.filter((r) => r.path !== stalePath);
        persistSession(openPaths, probe.path);
        persistRecents(recents);
        set({ openPaths, recents });
      }
      await get().loadRepo(probe.path);
    },

    clearRecents: () => {
      persistRecents([]);
      set({ recents: [] });
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
          const noWip =
            changes.staged.length === 0 &&
            changes.unstaged.length === 0 &&
            changes.conflicted.length === 0;
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
            // A failed status read leaves the prior advisory untouched (avoid
            // flickering the banner on a transient error).
            operationAdvisory: opStatus ? opStatus.advisory || null : get().operationAdvisory,
            // Only clear the spinner if this call owned it (non-quiet). The quiet
            // watcher path never set it, so it must not clear a concurrent load's.
            ...(opts?.quiet ? {} : { loading: false }),
            ...(selectedFileGone ? { selectedFile: null, fileDiff: null } : {}),
            ...(get().wipSelected && noWip ? { wipSelected: false } : {}),
          });
          // A working-tree comparison (head: null) reflects the live tree, so a
          // worktree-scope event (edit/stage/terminal commit) must refresh it.
          // Ref-to-ref comparisons are pinned to commits and don't change here.
          if (get().compare?.head === null) void get().refreshCompare();
          // The changed-files list updated above, but the file open in the diff
          // viewer (`fileDiff`) is a separate slice `refresh` doesn't touch — so
          // an external edit to it would stay stale until re-click. Refetch it
          // quietly; skip when it was just cleared as gone (GL-123).
          if (!selectedFileGone) void reconcileFileDiff(set, get, summary.path);
          return;
        }

        // Open first, alone: its classified rejection is what distinguishes a
        // repo whose path vanished mid-session from a real failure (GL-108), so
        // it must not race the other reads' plain string errors inside the
        // Promise.all (which rejects with whichever settles first). It's a
        // cheap in-process libgit2 metadata read — the serialization is free.
        const nextSummary = await api.openRepo(summary.path);
        const [graph, branches, worktrees, stashes, changes, forge, opStatus] =
          await Promise.all([
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
        // Reconcile the merged-selection union with the (possibly trimmed)
        // selection: an unchanged commit *set* keeps its files (immutable by
        // oid); a changed set is reloaded; a collapse to ≤1 commit drops it.
        const prevDiff = get().selectionDiff;
        const multiNow = selectedCommits.length > 1;
        const sameSet =
          multiNow &&
          !!prevDiff &&
          prevDiff.commits.length === selectedCommits.length &&
          selectedCommits.every((id) => prevDiff.commits.includes(id));
        // Reuse the cached union only when the set is unchanged *and* it
        // succeeded — a stored error (or an in-flight load that errored) must be
        // retried on refresh, not carried forward until the user re-selects.
        const reuseUnion = sameSet && !prevDiff!.error;
        const selectionDiff = !multiNow
          ? null
          : reuseUnion
            ? // Same commit *set*: keep the files (immutable by oid) but adopt the
              // refreshed order so `selectionDiff.commits` can't drift from
              // `selectedCommits`.
              { ...prevDiff!, commits: selectedCommits }
            : { commits: selectedCommits, files: [], loading: true, error: null };
        // Drop a selected working-tree file that no longer has changes (e.g. it
        // was committed/discarded outside the app) so the diff pane can't go stale.
        const sel = get().selectedFile;
        const gone =
          sel &&
          sel.source !== "commit" &&
          !changes.staged.some((f) => f.path === sel.path) &&
          !changes.unstaged.some((f) => f.path === sel.path);
        // If the WIP node was selected but there are no more changes, drop it.
        // Conflicted paths count as changes so a conflict-only worktree keeps WIP.
        const noWip =
          changes.staged.length === 0 &&
          changes.unstaged.length === 0 &&
          changes.conflicted.length === 0;
        set({
          summary: nextSummary,
          // Keep the active tab's label truthful — a checkout (in-app or
          // terminal) changes the branch a worktree tab shows. Persisted below
          // so a restored session labels the tab correctly on first paint.
          tabInfoByPath: {
            ...get().tabInfoByPath,
            [nextSummary.path]: tabInfoFromSummary(nextSummary),
          },
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
          operationAdvisory: opStatus ? opStatus.advisory || null : get().operationAdvisory,
          selectedCommit,
          selectedCommits,
          selectionAnchor,
          selectionDiff,
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
        persistTabInfo(get().tabInfoByPath);
        // The union needs (re)loading whenever we didn't reuse a healthy cached
        // one — set changed, or a prior error to retry. Fire-and-forget so it
        // doesn't delay the queue.
        if (multiNow && !reuseUnion) void loadSelectionUnion(set, get, nextSummary.path, selectedCommits);
        // Reconcile the open working-tree diff after a full refresh too — see the
        // worktree-scope path above; skip when the selection was cleared as gone (GL-123).
        if (!gone) void reconcileFileDiff(set, get, nextSummary.path);
        // A full refresh can move branch/commit tips, so re-run any open
        // comparison (ref-to-ref as well as working-tree) to keep it truthful.
        if (get().compare) void get().refreshCompare();
        if (opts?.prs !== false) void usePulls.getState().loadPullRequests(false, true);
        // A non-quiet refresh held `loading`; replay anything deferred during it.
        flushPendingRefresh();
      } catch (e) {
        if (generation !== null && !graphRequestIsCurrent(generation, summary.path)) {
          flushPendingRefresh();
          return;
        }
        // A refresh failing because the repo's path vanished (deleted, or its
        // volume unmounted under an open tab) swaps in the missing-repo state
        // instead of the raw error (GL-108). Re-guard after the async probe —
        // a newer load may have replaced the displayed repo meanwhile.
        const missing = await wentMissing(summary.path, e);
        if (get().summary?.path === summary.path) {
          if (missing) {
            // A full refresh owns a graph generation; a worktree-scope re-sync
            // has none (generation === null), so fall back to the displayed-path
            // guard for it.
            await handleMissing(summary.path, missing, () =>
              generation !== null
                ? graphRequestIsCurrent(generation, summary.path)
                : repoStillDisplayed(summary.path),
            );
          } else {
            // When this refresh owns the graph request (generation !== null), clear
            // graphLoading too: it may have superseded the initial open, whose
            // orphaned load can't clear the skeleton itself (GL-20 review).
            set({
              loading: false,
              error: errorText(e),
              ...(generation !== null ? { graphLoading: false } : {}),
            });
          }
        }
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

    loadReflog: async () => {
      const { summary } = get();
      if (!summary) return;
      set({ reflogLoading: true, reflogError: null });
      try {
        const reflogEntries = await api.listReflog(summary.path, 120);
        if (get().summary?.path !== summary.path) return;
        set({ reflogEntries, reflogLoading: false });
      } catch (e) {
        if (get().summary?.path !== summary.path) return;
        set({ reflogLoading: false, reflogError: String(e) });
      }
    },
  };
}
