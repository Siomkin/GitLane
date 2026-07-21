// Opening a repository (GL-158: the tab/session actions live in
// repoTabActions.ts, the re-sync actions in repoRefreshActions.ts): the folder
// picker, the two-phase loadRepo swap, and the missing-repo recovery entry
// points (Locate… and init-in-place). The GL-108/GL-126 routing itself lives
// in repoMissing.ts; the ownership guards in repoGuards.ts.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, isRepoOpenError, type RepoSummary } from "@/lib/api";
import { repoLabel } from "@/lib/paths";
import { groupedInsertIndex, pruneTabInfo, tabInfoFromSummary } from "@/lib/tabs";
import { repoIdentityKey } from "@/lib/worktrees";
import { useAccounts } from "./accounts";
import { mergeOperationStatus } from "./operation";
import { migrateIdentityBindings } from "./identities";
import { usePulls } from "./pulls";
import {
  flushPendingRefresh,
  graphRequestIsCurrent,
  repoStillDisplayed,
} from "./repoGuards";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import {
  beginGraphRequest,
  claimOpenIntent,
  openIntentIsCurrent,
} from "./repoRequests";
import {
  persistRecents,
  persistSession,
  persistTabInfo,
  upsertRecent,
} from "./repoSession";
import { unwatchRepo, watchRepo } from "./repoWatchQueue";
import { probeDirtyWorktrees } from "./repoWorktreeDirty";
import { useUi } from "./ui";
import {
  emptyChanges,
  INITIAL_GRAPH_LIMIT,
  type RepoGet,
  type RepoSet,
  type RepoState,
} from "./repoTypes";

export function createRepoLifecycleActions(
  set: RepoSet,
  get: RepoGet,
): Pick<RepoState, "pickAndOpen" | "loadRepo" | "locateMissingRepo" | "initMissingRepo"> {
  const { wentMissing, handleMissing, surfaceOpenFailure } = createMissingRepoHandlers(set, get);

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
        // history/compare/files view mounted against the new (or null) summary.
        fileHistory: null,
        compare: null,
        repoFiles: null,
        fileView: null,
        selectionDiff: null,
        graphLimit: INITIAL_GRAPH_LIMIT,
        loadingMoreHistory: false,
      });

      // Watch the new worktree as soon as the shell swaps — before the graph — so a
      // commit/checkout during the (slow) graph load still triggers a refresh, and a
      // graph failure below can't leave the now-active repo unwatched (GL-20 review).
      // Keyed by `summary.path` (the openPaths identity): each open tab keeps its
      // own watch, so switching tabs no longer silences the previous repo (GL-116).
      // Sequenced per path so a close→reopen of the same repo can't leave it
      // unwatched (GL-125).
      void watchRepo(summary.path);
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
        void unwatchRepo(opts.replaceTab);
      }

      // A repo switch resets the view (history tab, review notes, history
      // search/filter, transient chrome — see `onRepoSwitched`) and invalidates
      // any open repo-bound overlay: a destructive confirm / reflog-recovery
      // dialog (impact + entries computed for the old repo) and any in-flight
      // prompt (e.g. a recovery-branch name carrying an OID from the old repo).
      // Confirming/submitting after the switch would act on the newly-active
      // repo, so close them here. The FS watcher re-syncs via `refresh` (not
      // `loadRepo`), so this never fires on a same-repo change — only a genuine
      // switch. GL-42 review.
      useUi.getState().onRepoSwitched();
      useUi.getState().closeConfirm();
      useUi.getState().closeRecovery();
      useUi.getState().closePrompt();
      // The hand-off dialog is repo-bound too — but its own success path routes
      // through loadRepo(destination), and closing it then would drop the result
      // screen mid-hand-off. Only close it when no move is in flight (GL-105).
      if (!useUi.getState().handoffRunning) useUi.getState().closeHandoff();
      // The delete-branch-and-worktree dialog is repo-bound (its preview/subject
      // are the old repo's) and — unlike hand-off — never switches repos itself:
      // success refreshes the same repo. So a genuine switch always invalidates
      // it; close it unconditionally. A delete already in flight keeps running and
      // reports via toast (deleteWorktreeRunning stays set until it settles, which
      // also blocks a second delete from a reopened dialog). GL-107.
      useUi.getState().closeDeleteWorktree();
      // The remove-detached sweep is repo-bound the same way (its targets are the
      // old repo's) and never switches repos itself, so a genuine switch always
      // invalidates it; close it unconditionally. An in-flight sweep keeps running
      // and reports via toast (removeDetachedRunning stays set until it settles).
      useUi.getState().closeRemoveDetached();

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
          if (repoStillDisplayed(get, summary.path)) set({ branches });
        })
        .catch((e) => {
          if (repoStillDisplayed(get, summary.path)) void surfaceOpenFailure(summary.path, e);
        });
      void api
        .listWorktrees(summary.path)
        .then((worktrees) => {
          if (!repoStillDisplayed(get, summary.path)) return;
          set({ worktrees });
          // Their uncommitted work is a second, per-worktree read — kicked off
          // once the list itself has landed and painted, never in front of it.
          probeDirtyWorktrees(set, get);
        })
        .catch(() => {});
      void api
        .listStashes(summary.path)
        .then((stashes) => {
          if (repoStillDisplayed(get, summary.path)) set({ stashes });
        })
        .catch(() => {});
      // The forge drives the toolbar provider indicator (which paints early), so
      // load it alongside the other secondary reads rather than behind the graph.
      // Best-effort: a detection failure degrades to "no forge", never the error bar.
      const forgeLoad = api
        .repoForge(summary.path)
        .then((forge) => {
          if (repoStillDisplayed(get, summary.path)) set({ forge });
        })
        .catch(() => {});
      // The remote list feeds the per-remote account resolution (GL-129): URL
      // usernames and any legacy binding migration need the remote names +
      // default remote, so re-sync the account slice once the list lands (the
      // early sync above ran without it).
      // Best-effort like the other secondary reads.
      const remotesLoad = api
        .listRemotes(summary.path)
        .then((remotes) => {
          if (repoStillDisplayed(get, summary.path)) {
            set({ remotes });
            useAccounts.getState().syncRepoAccount(summary.path);
          }
        })
        .catch(() => {});
      void Promise.allSettled([forgeLoad, remotesLoad]).then(() => {
        // Fire the quiet PR-badge load only once the forge is known, so the
        // GitHub-only gate in `loadPullRequests` applies on first paint — a
        // non-GitHub / no-remote repo then skips `gh` instead of surfacing a
        // confusing "couldn't resolve a GitHub repository" error. Waiting on the
        // remotes too means the load fetches as the *default remote's* bound
        // account rather than racing the per-remote resolution (GL-129). Both
        // are cheap libgit2 reads and PRs don't gate first paint, so the wait is
        // free. The panel isn't shown yet; opening it does its own foreground load.
        if (repoStillDisplayed(get, summary.path)) {
          void usePulls.getState().loadPullRequests(false, true);
        }
      });
      void api
        .workingChanges(summary.path)
        .then((changes) => {
          if (repoStillDisplayed(get, summary.path)) set({ changes });
        })
        .catch((e) => {
          if (repoStillDisplayed(get, summary.path)) void surfaceOpenFailure(summary.path, e);
        });
      // The active operation (merge/rebase/cherry-pick/revert) gates the
      // conflict workspace. Best-effort: a detection failure degrades to "no
      // operation", never the error bar. The union starts fresh (operation was
      // cleared in Phase 2 above).
      void api
        .operationStatus(summary.path)
        .then((status) => {
          if (repoStillDisplayed(get, summary.path)) {
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
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
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
              if (repoStillDisplayed(get, summary.path) && get().selectedCommit === selectedCommit) {
                set({ commitFiles });
              }
            })
            .catch(() => {});
        }
        // Replay any watcher/focus re-sync that arrived while this load held `loading`.
        flushPendingRefresh(get);
      } catch (e) {
        // Only clear the loading flags if this request still owns the active repo —
        // a newer load may have superseded us while the graph was in flight.
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        // The repo can vanish between the open and the (slow) graph read —
        // classify before surfacing so even this window can't show the raw
        // libgit2 message (GL-108). Re-guard after the async probe.
        const missing = await wentMissing(summary.path, e);
        if (!graphRequestIsCurrent(get, generation, summary.path)) return;
        if (missing)
          // `intent` (claimed at this loadRepo's start, before every await) is
          // the open-intent baseline: a competing switch bumps it, flipping the
          // token even before that switch publishes its summary/generation.
          await handleMissing(
            summary.path,
            missing,
            () => graphRequestIsCurrent(get, generation, summary.path) && openIntentIsCurrent(intent),
          );
        else set({ loading: false, graphLoading: false, error: errorText(e) });
        flushPendingRefresh(get);
      }
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
        migrateIdentityBindings(stalePath, probe.path);
        // The dead path may still hold a watch from before it went missing;
        // its tab is being re-keyed, so release the stale entry (GL-116).
        void unwatchRepo(stalePath);
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

    // Initialize as git repo… (GL-153): the `notARepository` case's folder
    // still has the user's files, so this runs `git init` right where it
    // stands (no picker, no README/.gitignore scaffolding) and opens it — a
    // lighter recovery than Locate… for the common "the .git got deleted"
    // case.
    initMissingRepo: async () => {
      const missing = get().missingRepo;
      if (!missing || missing.kind !== "notARepository") return;
      if (get().initMissingRepoRunning) return;
      const { path } = missing;
      set({ initMissingRepoRunning: true });
      try {
        try {
          await api.initRepoInPlace(path);
        } catch (e) {
          const message = errorText(e);
          // The repo may have become openable while the confirm dialog was up
          // (another tool re-created `.git`, or a concurrent Retry succeeded).
          if (message.includes("already a Git repository") && get().missingRepo?.path === path) {
            await get().loadRepo(path);
            return;
          }
          useUi.getState().showToast(message, "error");
          return;
        }
        // The tab may have moved on while the (fast, local) init was in flight
        // — e.g. Remove/Retry/Locate… resolved it first. Don't stomp on that.
        if (get().missingRepo?.path !== path) return;
        await get().loadRepo(path);
      } finally {
        set({ initMissingRepoRunning: false });
      }
    },
  };
}
