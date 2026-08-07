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
  readRequestIsCurrent,
  repoSessionIsCurrent,
} from "./repoGuards";
import { createMissingRepoHandlers, errorText } from "./repoMissing";
import {
  beginMetadataRequest,
  beginPublishedRepoSession,
  beginRemotesRequest,
  beginTabLifetime,
  claimPrPrefetch,
  endTabLifetime,
  ensureTabLifetime,
  graphRequests,
  markMetadataReadyForPr,
  markRemotesReadyForPr,
  metadataRequests,
  openIntent,
  remotesRequests,
  requestPrPrefetch,
  tabLifetimeIsCurrent,
  type TabLifetimeLease,
  worktreeRequests,
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
      const intent = openIntent.claim();
      const initialPaths = get().openPaths;
      // Activating an existing tab owns that exact tab lifetime. Closing it
      // while open_repo is pending invalidates this lease, so the completion
      // cannot silently re-add the path. A genuinely new target has no tab
      // lifetime until phase 2 publishes it; the global open intent still gives
      // concurrent new opens their latest-pick ordering.
      // Snapshot every initially-live path because open_repo can canonicalize a
      // subdirectory/symlink pick to an already-open repository path. Once the
      // canonical summary arrives we can then prove that exact tab survived the
      // await, without coupling a genuinely new target to unrelated tabs.
      const initialTabOwners = new Map(
        initialPaths.map((openPath) => [openPath, ensureTabLifetime(openPath)]),
      );
      const targetOwner = initialTabOwners.get(path) ?? null;
      // In-place switches additionally own the source tab. If the source closes
      // while the destination is resolving, the operation no longer has a tab
      // to replace and must stand down instead of appending the destination.
      const replacementOwner = opts?.replaceTab
        ? initialTabOwners.get(opts.replaceTab) ?? null
        : null;
      const tabOwnerIsCurrent = (owner: TabLifetimeLease | null) =>
        owner === null ||
        (tabLifetimeIsCurrent(owner) && get().openPaths.includes(owner.path));
      const openOwnerIsCurrent = () =>
        openIntent.isCurrent(intent) &&
        tabOwnerIsCurrent(targetOwner) &&
        tabOwnerIsCurrent(replacementOwner);

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
        if (openOwnerIsCurrent()) {
          // A vanished path gets the dedicated missing-repo state — tab click,
          // startup restore, and a recents open all funnel through here
          // (GL-108). Other failures keep the GL-20 behavior: error bar only,
          // the current repo untouched.
          const missing = isRepoOpenError(e) && e.kind !== "other" ? e.kind : null;
          if (missing) await handleMissing(path, missing, openOwnerIsCurrent);
          else set({ error: errorText(e) });
        }
        return;
      }
      // A newer pick superseded us while we were opening → drop this stale open so
      // it can't publish over the repo the user landed on.
      const canonicalTargetOwner = initialTabOwners.get(summary.path) ?? null;
      if (!openOwnerIsCurrent() || !tabOwnerIsCurrent(canonicalTargetOwner)) return;

      // Phase 2 — commit to the switch. Bump the generation (superseding any
      // in-flight graph request) and, in one atomic commit, publish the new summary,
      // drop the previous repo's graph/refs/changes, and raise the loading +
      // skeleton flags. The bump and this set share a synchronous tick, so no other
      // load can interleave between them.
      const generation = graphRequests.claim();
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
      } else if (
        replacementOwner &&
        opts?.replaceTab &&
        prevPaths.includes(opts.replaceTab)
      ) {
        openPaths = prevPaths.map((p) => (p === opts.replaceTab ? summary.path : p));
      } else {
        const at = groupedInsertIndex(prevPaths, get().tabInfoByPath, repoIdentityKey(summary));
        openPaths = [...prevPaths.slice(0, at), summary.path, ...prevPaths.slice(at)];
      }
      const addedTarget = !prevPaths.includes(summary.path);
      const replacedSource =
        replacementOwner &&
        opts?.replaceTab &&
        opts.replaceTab !== summary.path &&
        prevPaths.includes(opts.replaceTab) &&
        !openPaths.includes(opts.replaceTab)
          ? opts.replaceTab
          : null;
      // Rotate lifetimes before persistence/UI/watch side effects. Published
      // repo-session guards take over after phase 2, so ending a replaced source
      // cannot invalidate any of the destination's secondary reads.
      if (replacedSource) endTabLifetime(replacedSource);
      if (addedTarget) beginTabLifetime(summary.path);
      else ensureTabLifetime(summary.path);
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
      // Rotate the displayed-session identity in the same synchronous phase-2
      // publication as the summary, including a same-path reopen.
      const session = beginPublishedRepoSession();
      // Claim one token per secondary-read batch. Each call in a lane shares
      // its token so it can land independently, while a newer same-lane load or
      // refresh suppresses every remaining completion from this batch.
      const metadataOwner = {
        path: summary.path,
        session,
        generation: beginMetadataRequest(),
      };
      const worktreeOwner = {
        path: summary.path,
        session,
        generation: worktreeRequests.claim(),
      };
      const remotesOwner = {
        path: summary.path,
        session,
        generation: beginRemotesRequest(),
      };
      const fileSelectionRequestId = get().fileSelectionRequestId + 1;
      const maybePrefetchPulls = () => {
        if (claimPrPrefetch(session)) {
          void usePulls.getState().loadPullRequests(false, true);
        }
      };
      requestPrPrefetch(session);
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
        fileSelectionRequestId,
        fileDiff: null,
        diffLoading: false,
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
      // One call, not a hand-picked subset (GL-358): the store states what a
      // switch invalidates, including the hand-off exception (its own success
      // path routes through loadRepo(destination), so a running move keeps its
      // result screen — GL-105) and the delete/sweep dialogs, which never switch
      // repos themselves and so are always stale. Anything still in flight keeps
      // running and reports via toast.
      useUi.getState().onRepoSwitched();

      // Reset PR state and resolve the new repo's account binding the moment the
      // summary is published — before awaiting the graph — so the ActionBar can't
      // pair the new repo's summary with the previous repo's PRs during a slow graph
      // load, and a graph failure can't strand stale PR state (GL-20 review).
      usePulls.getState().reset();
      // Resolve this repo's bound account so the PR badge load (fired once the
      // forge is known, below) fetches as that account.
      if (readRequestIsCurrent(get, remotesRequests, remotesOwner)) {
        useAccounts.getState().syncRepoAccount(summary.path);
      }

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
          if (readRequestIsCurrent(get, metadataRequests, metadataOwner)) set({ branches });
        })
        .catch((e) => {
          void surfaceOpenFailure(
            summary.path,
            e,
            () =>
              openIntent.isCurrent(intent) &&
              readRequestIsCurrent(get, metadataRequests, metadataOwner),
          );
        });
      void api
        .listWorktrees(summary.path)
        .then((worktrees) => {
          if (!readRequestIsCurrent(get, metadataRequests, metadataOwner)) return;
          set({ worktrees });
          // Their uncommitted work is a second, per-worktree read — kicked off
          // once the list itself has landed and painted, never in front of it.
          // It inherits this read's ownership guard: probing dirtiness for a
          // superseded load would publish into the repo the user left.
          probeDirtyWorktrees(set, get);
        })
        .catch(() => {});
      void api
        .listStashes(summary.path)
        .then((stashes) => {
          if (readRequestIsCurrent(get, metadataRequests, metadataOwner)) set({ stashes });
        })
        .catch(() => {});
      // The forge drives the toolbar provider indicator (which paints early), so
      // load it alongside the other secondary reads rather than behind the graph.
      // Best-effort: a detection failure degrades to "no forge", never the error bar.
      void api
        .repoForge(summary.path)
        .then((forge) => {
          if (readRequestIsCurrent(get, metadataRequests, metadataOwner)) {
            set({ forge });
            markMetadataReadyForPr(session, metadataOwner.generation, forge !== null);
            maybePrefetchPulls();
          }
        })
        .catch(() => {
          if (readRequestIsCurrent(get, metadataRequests, metadataOwner)) {
            // Phase 2 already published the terminal best-effort fallback.
            markMetadataReadyForPr(session, metadataOwner.generation, false);
            maybePrefetchPulls();
          }
        });
      // The remote list feeds the per-remote account resolution (GL-129): URL
      // usernames and any legacy binding migration need the remote names +
      // default remote, so re-sync the account slice once the list lands (the
      // early sync above ran without it).
      // Best-effort like the other secondary reads.
      void api
        .listRemotes(summary.path)
        .then((remotes) => {
          if (readRequestIsCurrent(get, remotesRequests, remotesOwner)) {
            set({ remotes });
            useAccounts.getState().syncRepoAccount(summary.path);
            markRemotesReadyForPr(session, remotesOwner.generation);
            maybePrefetchPulls();
          }
        })
        .catch(() => {
          if (readRequestIsCurrent(get, remotesRequests, remotesOwner)) {
            // Phase 2 already published []; account resolution ran once against
            // that terminal fallback before the read batch started.
            markRemotesReadyForPr(session, remotesOwner.generation);
            maybePrefetchPulls();
          }
        });
      void api
        .workingChanges(summary.path)
        .then((changes) => {
          if (readRequestIsCurrent(get, worktreeRequests, worktreeOwner)) set({ changes });
        })
        .catch((e) => {
          void surfaceOpenFailure(
            summary.path,
            e,
            () =>
              openIntent.isCurrent(intent) &&
              readRequestIsCurrent(get, worktreeRequests, worktreeOwner),
          );
        });
      // The active operation (merge/rebase/cherry-pick/revert) gates the
      // conflict workspace. Best-effort: a detection failure degrades to "no
      // operation", never the error bar. The union starts fresh (operation was
      // cleared in Phase 2 above).
      void api
        .operationStatus(summary.path)
        .then((status) => {
          if (readRequestIsCurrent(get, worktreeRequests, worktreeOwner)) {
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
              if (
                repoSessionIsCurrent(get, summary.path, session) &&
                get().fileSelectionRequestId === fileSelectionRequestId &&
                get().selectedCommit === selectedCommit
              ) {
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
        if (missing) {
          // `intent` (claimed at this loadRepo's start, before every await) is
          // the open-intent baseline: a competing switch bumps it, flipping the
          // token even before that switch publishes its summary/generation.
          const transitioned = await handleMissing(
            summary.path,
            missing,
            () => graphRequestIsCurrent(get, generation, summary.path) && openIntent.isCurrent(intent),
          );
          if (!transitioned && graphRequestIsCurrent(get, generation, summary.path)) {
            // A newer phase-1 open can suppress this missing transition without
            // yet owning the loading flags. Release the old graph shell so a
            // later failed pick cannot leave it stuck.
            set({ loading: false, graphLoading: false });
          }
        } else if (openIntent.isCurrent(intent)) {
          set({ loading: false, graphLoading: false, error: errorText(e) });
        } else {
          set({ loading: false, graphLoading: false });
        }
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
        const staleWasOpen = get().openPaths.includes(stalePath);
        const targetWasOpen = get().openPaths.includes(probe.path);
        if (staleWasOpen) endTabLifetime(stalePath);
        if (targetWasOpen) ensureTabLifetime(probe.path);
        else if (staleWasOpen) beginTabLifetime(probe.path);
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
