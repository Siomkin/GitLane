// Helpers shared by every write-action slice: ownership capture (which repo /
// session a write belongs to), the `runOp` / `runMaybeConflict` bodies, the
// toast policies, and the ref-snapshot resolvers. Slices import from here; they
// never import each other.

import { api, BranchKind, type FileChange, type RepoSummary } from "@/lib/api";
import { fileWriteGuard } from "@/lib/advancedRepoState";
import { findOtherBranchWorktree, type WorktreeRef } from "@/lib/graphActions";
import { stashWasRoutine } from "@/lib/stashOutcome";
import { flushPendingRefresh } from "@/store/repoGuards";
import {
  planSectionAvailability,
  reportSectionFailure,
  settleRead,
} from "@/store/repoRefresh/sectionFailures";
import { openIntent, publishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import type { RepoGet, RepoSet, RepoState } from "@/store/repoTypes";

// The old-side path of a rename ("R") entry for `path` in `bucket`, or null when
// it isn't a rename. Only renames need both sides staged/unstaged together
// (GL-127): a rename deletes the old path, so acting on the new path alone leaves
// that deletion in the opposite state. A copy ("C") is deliberately excluded —
// it leaves the old path intact, so it must NOT be touched. An "R" with no
// `previousPath` is a backend-invariant breach (post-GL-127 the status pass
// always fills it); warn rather than silently fall back to single-path staging,
// which would resurrect the half-staged-rename bug instead of failing loudly.
function renameOldPath(entry: FileChange | undefined): string | null {
  if (entry?.status !== "R") return null;
  if (!entry.previousPath) {
    console.warn(
      `GL-127: rename entry "${entry.path}" is missing previousPath; staging its new side only`,
    );
    return null;
  }
  return entry.previousPath;
}

// The two paths a rename spans, or null for an ordinary single-path change — so
// the caller can keep using the single-path git command for non-renames.
export function renamePaths(bucket: FileChange[], path: string): string[] | null {
  const old = renameOldPath(bucket.find((f) => f.path === path));
  return old ? [old, path] : null;
}

// Expand a path list so any rename in `bucket` also contributes its old side.
// Folder roll-ups (stagePaths/unstagePaths) pass new-side paths only; without
// this a rename under a rolled-up directory would leave the old path's deletion
// in the opposite state (the same GL-127 bug in the bulk flows).
// De-duplicated (a rename and its source both selected won't double up); order
// preserved for stable git invocations.
export function withRenameCounterparts(bucket: FileChange[], paths: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const byPath = new Map(bucket.map((entry) => [entry.path, entry]));
  const push = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const path of paths) {
    push(path);
    const old = renameOldPath(byPath.get(path));
    if (old) push(old);
  }
  return out;
}

// Shared body for the branch/history write ops: require an open repo, run the
// op, refresh the graph, and return a human-readable outcome string. Callers
// toast errors only — routine success is silent (the graph/navigator update).
// Rejects when there's no repo or the git op throws.
export type RepoWriteOwner = Readonly<{
  path: string;
  openIntent: number;
  publishedSession: number;
}>;

export function captureOwner(summary: RepoSummary): RepoWriteOwner {
  return {
    path: summary.path,
    openIntent: openIntent.current(),
    publishedSession: publishedRepoSession.current(),
  };
}

export function ownerIsCurrent(get: RepoGet, owner: RepoWriteOwner): boolean {
  return get().summary?.path === owner.path &&
    publishedRepoSession.isCurrent(owner.publishedSession);
}

// Store publication belongs to the displayed session above. Automatic
// navigation is stricter: a newer user open wins as soon as it is claimed,
// even while its phase-1 probe is still pending (and even if it later fails).
export function ownerMayNavigate(get: RepoGet, owner: RepoWriteOwner): boolean {
  return ownerIsCurrent(get, owner) && openIntent.isCurrent(owner.openIntent);
}

export async function refreshIfCurrent(
  get: RepoGet,
  owner: RepoWriteOwner,
  opts?: Parameters<RepoState["refresh"]>[0],
): Promise<boolean> {
  if (!ownerIsCurrent(get, owner)) return false;
  const refreshed = await get().refresh(opts);
  return refreshed && ownerIsCurrent(get, owner);
}

export function releaseLoadingIfCurrent(
  set: RepoSet,
  get: RepoGet,
  owner: RepoWriteOwner,
  flush = false,
): boolean {
  if (!ownerIsCurrent(get, owner)) return false;
  set({ loading: false });
  if (flush) flushPendingRefresh(get);
  return true;
}

export type FileSelectionOwner = Readonly<{
  requestId: number;
  fileView: RepoState["fileView"];
}>;

export function captureFileSelection(get: RepoGet): FileSelectionOwner {
  return { requestId: get().fileSelectionRequestId, fileView: get().fileView };
}

export function fileSelectionIsCurrent(get: RepoGet, owner: FileSelectionOwner): boolean {
  return get().fileSelectionRequestId === owner.requestId && get().fileView === owner.fileView;
}

export function commitSetIsCurrent(get: RepoGet, commits: string[]): boolean {
  return get().selectedCommits === commits;
}

export async function runOp(
  get: RepoGet,
  body: (summary: RepoSummary, owner: RepoWriteOwner) => Promise<string>,
  opts?: { refreshOnError?: boolean },
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const owner = captureOwner(summary);
  let message: string;
  try {
    message = await body(summary, owner);
  } catch (error) {
    if (opts?.refreshOnError) {
      // Some guarded writes can fail after a partial mutation. Refresh the
      // originating repo, but always rethrow the backend's actionable error —
      // a secondary refresh failure must not replace the operation outcome.
      try {
        await refreshIfCurrent(get, owner);
      } catch {
        // `refresh` currently reports failure as `false`, but keep this boundary
        // fail-safe if that contract ever regresses or a test double rejects.
      }
    }
    throw error;
  }
  await refreshIfCurrent(get, owner);
  return message;
}

// Like `runOp`, but for operations that can legitimately stop on conflicts
// (merge/rebase/cherry-pick/revert). Git exits non-zero when it stops on a
// conflict, but that is not a failure — it's an invitation to resolve. So after
// any error we refresh and check whether an operation is now active: if so, the
// conflict is the outcome (the App surfaces the ConflictWorkspace off
// `operation`), and we return an informational message instead of throwing.
// A genuine failure (no operation in progress) still rejects for the caller to
// toast as an error.
export async function runMaybeConflict(
  get: RepoGet,
  body: (summary: RepoSummary) => Promise<string>,
  inProgressLabel: string,
): Promise<string> {
  const { summary } = get();
  if (!summary) throw new Error("No repository");
  const owner = captureOwner(summary);
  // Capture whether an operation was ALREADY active before we start: only a
  // *newly* entered operation means this op stopped on conflicts. If one was
  // already in progress (e.g. a terminal-started merge, or a second attempt
  // while the workspace is open), git's failure is genuine and must surface —
  // otherwise every error would be masked as a benign "resolve conflicts".
  const hadOperation = !!get().operation;
  try {
    const message = await body(summary);
    // Don't refresh/publish onto a different repo if the user switched mid-op.
    await refreshIfCurrent(get, owner);
    return message;
  } catch (e) {
    // Switched repos mid-op: surface the raw error; never interpret it (or the
    // global operation) against the now-current, unrelated repo.
    if (!ownerIsCurrent(get, owner)) throw e;
    await refreshIfCurrent(get, owner);
    if (ownerIsCurrent(get, owner) && !hadOperation && get().operation) {
      // Deliberately not toasted: `operation` outranks every other center view
      // (deriveCenterView, app-shell/centerView.ts), so the ConflictWorkspace
      // swaps the whole pane — a louder confirmation than a sentence, and it
      // shows even when the PRs tab is active. The string is for callers that
      // want to log or label the outcome.
      return `${inProgressLabel} — resolve conflicts to continue`;
    }
    throw e;
  }
}

// Write ops flush the deferred re-sync via the shared repoGuards helper:
// `refresh` already flushes on its own success/failure, but a write op's
// failure path clears `loading` without going through `refresh`, so the queued
// re-sync would otherwise be stranded until the next external event (GL-20).

export function toastAdvancedGuard(message: string | null): boolean {
  if (!message) return false;
  useUi.getState().showToast(message, "error");
  return true;
}

/** Error toast for a write that can be retried after stranded-index.lock recovery. */
export function toastWriteError(
  get: RepoGet,
  error: unknown,
  retry: () => void | Promise<void>,
): void {
  useUi.getState().showToast(error, "error", {
    retry,
    repoPath: get().summary?.path,
  });
}

/** Toast a write's outcome and hand it back, for the few ops whose result no
 * view renders — the message is the only place it exists. Most writes stay
 * silent instead; see the policy note in `store/notifications.ts`. */
export function toastOutcome(message: string): string {
  useUi.getState().showToast(message);
  return message;
}

/** Routine stash success is silent (the stash list updates). Recovered /
 * partial-cleanup messages still toast so a split state isn't invisible —
 * `stashWasRoutine` owns that classification. */
export function toastStashOutcome(message: string) {
  if (stashWasRoutine(message)) return;
  useUi.getState().showToast(message);
}

export function guardedPathMessage(get: RepoGet, path: string): string | null {
  const { changes } = get();
  return fileWriteGuard(
    [...changes.unstaged, ...changes.staged].find((file) => file.path === path),
    changes,
  );
}

export function requireHeadOid(summary: RepoSummary, operation: string): string {
  if (!summary.headOid) {
    throw new Error(`Cannot ${operation}: HEAD has no commit.`);
  }
  return summary.headOid;
}

export function revisionSnapshot(
  get: RepoGet,
  revision: string,
): { revision: string; oid: string } {
  if (revision === "HEAD") {
    const summary = get().summary;
    if (!summary?.headOid) throw new Error("HEAD has no commit. Refresh and try again.");
    return { revision, oid: summary.headOid };
  }
  const matches = get().branches.filter((candidate) => candidate.name === revision);
  if (matches.length > 1) {
    throw new Error(`Cannot resolve ambiguous ref ${revision}. Refresh and choose it again.`);
  }
  const [branch] = matches;
  if (branch?.target) {
    return {
      revision: branch.kind === BranchKind.Local
        ? `refs/heads/${branch.name}`
        : `refs/remotes/${branch.name}`,
      oid: branch.target,
    };
  }
  // Commit-menu and graph-row callers already carry an immutable oid.
  if (/^[0-9a-f]{7,64}$/i.test(revision)) return { revision, oid: revision };
  throw new Error(`Cannot resolve ${revision}. Refresh and try again.`);
}

export function localBranchOid(get: RepoGet, branch: string): string {
  const oid = get().branches.find(
    (candidate) => candidate.kind === BranchKind.Local && candidate.name === branch,
  )?.target;
  if (!oid) throw new Error(`Cannot find branch ${branch}. Refresh and try again.`);
  return oid;
}

export async function findCheckoutWorktree(
  set: RepoSet,
  get: RepoGet,
  summary: RepoSummary,
  owner: RepoWriteOwner,
  branch: string,
): Promise<WorktreeRef | null> {
  const currentWorkdir = summary.workdir ?? summary.path;
  const cached = findOtherBranchWorktree(get().worktrees, branch, currentWorkdir);
  if (cached) return cached;

  // On checkout, a cached miss is not enough: the branch may be held by a
  // worktree that is still loading, so probe once before falling through to
  // git. A failed probe keeps the cached list (flagged unavailable) and lets
  // git decide; it never blanks the worktree section.
  const read = await settleRead(api.listWorktrees(summary.path));
  if (read.status === "rejected") {
    if (ownerIsCurrent(get, owner)) {
      reportSectionFailure(set, get().unavailableSections, "worktrees", read.reason);
    }
    return null;
  }
  if (!ownerIsCurrent(get, owner)) {
    throw new Error("Repository changed while checking worktrees. Try again.");
  }
  const worktrees = read.value;
  const availability = planSectionAvailability(get().unavailableSections, { worktrees: null });
  set({ worktrees, ...availability.patch });
  availability.notify();
  return findOtherBranchWorktree(worktrees, branch, currentWorkdir);
}
