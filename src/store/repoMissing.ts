// The missing-repo state machine: the GL-108 recovery screen for a moved or
// deleted standalone repository, and the GL-126 fallback that retires a
// removed *linked worktree* to a usable context instead of stranding on that
// screen. `createMissingRepoHandlers` returns the classify/route handlers the
// lifecycle and refresh slices share; the routing internals stay private here.

import { api, isRepoOpenError } from "@/lib/api";
import { pruneTabInfo, type TabInfo } from "@/lib/tabs";
import { trimTrailingSlash } from "@/lib/worktrees";
import { usePulls } from "./pulls";
import {
  beginGraphRequest,
  currentOpenIntent,
  openIntentIsCurrent,
} from "./repoRequests";
import { repoStillDisplayed } from "./repoGuards";
import { unwatchRepo } from "./repoWatchQueue";
import {
  persistRecents,
  persistSession,
  persistTabInfo,
  readLastPath,
} from "./repoSession";
import { useUi } from "./ui";
import {
  emptyChanges,
  INITIAL_GRAPH_LIMIT,
  type MissingRepoState,
  type RepoGet,
  type RepoSet,
} from "./repoTypes";

// Human text for a failed open/read: the classified `open_repo` rejection
// carries a readable message (GL-108); everything else stringifies as before.
export const errorText = (e: unknown) => (isRepoOpenError(e) ? e.message : String(e));

// NOTE: instantiated once per slice (the lifecycle AND refresh factories each
// call this), which is safe only while the handlers stay stateless closures
// over set/get. Do not add module- or factory-level mutable state here — put
// coordination state in repoRequests.ts (module-level, shared) instead.
export function createMissingRepoHandlers(set: RepoSet, get: RepoGet) {
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
      remotes: [],
      graph: null,
      branches: [],
      reflogEntries: [],
      reflogLoading: false,
      reflogError: null,
      worktrees: [],
      dirtyWorktrees: [],
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
      repoFiles: null,
      fileView: null,
      error: null,
    });
    // Same repo-bound cleanup as a switch: PR state and any open repo-bound
    // overlay were computed for a repo that is no longer on screen. The view
    // reset covers the dead-tab-to-dead-tab switch too (GL-108): no summary
    // changes, but it's still a repo switch for the history/notes cleanup.
    usePulls.getState().reset();
    useUi.getState().onRepoSwitched();
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
    void unwatchRepo(path);

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
        // Not open: only switch to it if it still resolves on disk, so we don't
        // trade one missing-repo screen for another.
        try {
          const [status] = await api.recentsStatus([parent]);
          if (status?.exists) target = parent;
        } catch {
          /* probe failed — fall back to another open tab */
        }
      }
    }
    const remaining = get().openPaths.filter((p) => p !== path);
    const prunedInfo = pruneTabInfo(get().tabInfoByPath, remaining);
    // A removed worktree isn't a repo to relocate — drop it from recents too so
    // the onboarding list doesn't offer a dead worktree with a Locate… action.
    const recents = get().recents.filter((r) => r.path !== path);
    if (!target) target = remaining[Math.max(0, openIndex - 1)] ?? remaining[0] ?? null;

    // Single ownership re-check before any mutation, covering both the async
    // parent probe above and the parent-already-open synchronous path. The
    // caller's `isCurrent` token folds in the open-intent baseline it captured
    // *before its own awaits*, so a repo switch initiated anywhere in this
    // window — which claims a newer intent before its summary/graph generation
    // publish, and so slips past `summary`/generation guards — flips it false.
    // When a newer operation owns the store, stand down without mutating shared
    // state or reloading; let it publish. The dead worktree tab self-heals on
    // its next activation (the store's usual async-ownership model).
    if (!isCurrent()) return;

    // Supersede any in-flight graph read for the dead worktree; clearing the
    // summary below also fails every summary-path guard, so nothing stale can
    // publish after this.
    beginGraphRequest();

    if (target) {
      // Clear the dead worktree's workspace *before* the async target open, so
      // the gone directory's graph/history isn't left on screen during the
      // handoff (matches closeRepo's neighbour switch); loadRepo then does the
      // full workspace swap and re-guards its own reads. Loading flags stay
      // false here: with `summary` null the app renders onboarding regardless of
      // them, and loadRepo raises its own skeleton on a successful open — so a
      // target whose open fails (a non-missing error only sets `error` and
      // returns, GL-20) can't strand the store "loading" over a null summary.
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
        loading: false,
        graphLoading: false,
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
      remotes: [],
      graph: null,
      branches: [],
      reflogEntries: [],
      reflogLoading: false,
      reflogError: null,
      worktrees: [],
      dirtyWorktrees: [],
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
      repoFiles: null,
      fileView: null,
      error: null,
    });
    usePulls.getState().reset();
    useUi.getState().onRepoSwitched();
    useUi.getState().closeConfirm();
    useUi.getState().closeRecovery();
    useUi.getState().closePrompt();
    // Match closeRepo's last-tab branch: a handoff dialog bound to the now-gone
    // worktree must not linger on the welcome screen (GL-42).
    useUi.getState().closeHandoff();
    useUi.getState().closeDeleteWorktree();
    useUi.getState().closeRemoveDetached();
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
    // Capture the open intent before the async classify probe: a repo switch
    // begun during it claims a newer intent before publishing, so fold this into
    // the ownership token handed to the worktree fallback (which would otherwise
    // steal focus back on the parent-already-open path).
    const entryIntent = currentOpenIntent();
    const kind = await wentMissing(path, e);
    if (!repoStillDisplayed(get, path)) return;
    if (kind)
      await handleMissing(
        path,
        kind,
        () => openIntentIsCurrent(entryIntent) && repoStillDisplayed(get, path),
      );
    else set({ error: errorText(e) });
  };

  return { wentMissing, handleMissing, surfaceOpenFailure };
}
