// Phase 3 of opening a repository: everything that must start before the graph
// is awaited.
//
// The filesystem watch, the view/overlay reset a switch implies, the PR reset
// and account resolution, and the secondary reads — fanned out independently so
// each fills its slice as it lands rather than queueing behind the graph. Every
// completion is guarded by repo identity, not the graph generation, so an
// unrelated refresh cannot drop a read that is still in flight.

import { api, type RepoSummary } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { usePulls } from "@/store/pulls";
import { mergeOperationStatus } from "@/store/operation";
import { readRequestIsCurrent } from "@/store/repoGuards";
import {
  markMetadataReadyForPr,
  markRemotesReadyForPr,
  metadataRequests,
  openIntent,
  remotesRequests,
  worktreeRequests,
} from "@/store/repoRequests";
import type { RepoGet, RepoSet } from "@/store/repoTypes";
import { probeDirtyWorktrees } from "@/store/repoWorktreeDirty";
import { useUi } from "@/store/ui";
import { unwatchRepo, watchRepo } from "@/store/repoWatchQueue";
import type { PublishedSwitch } from "./publishSwitch";

export function startRepoSideEffects(
  set: RepoSet,
  get: RepoGet,
  summary: RepoSummary,
  opts: { replaceTab?: string } | undefined,
  intent: number,
  published: PublishedSwitch,
  surfaceOpenFailure: (path: string, error: unknown, isCurrent: () => boolean) => Promise<void>,
): void {
  const {
    openPaths,
    session,
    metadataOwner,
    worktreeOwner,
    remotesOwner,
    maybePrefetchPulls,
  } = published;
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
}
