import type { WorktreeDirtyState } from "@/lib/api";

/** What the removal is acting on, gathered from the live worktree entry / lease preview. */
export interface RemoveWorktreeSubject {
  name: string;
  path: string;
  /** Checked-out branch, or null when the worktree is detached. */
  branch: string | null;
  /** HEAD oid — the only handle on a detached worktree's commits. */
  head?: string | null;
  locked: boolean;
  /** Probed uncommitted work from the lease preview (ignored disclosed, not leased). */
  dirty: WorktreeDirtyState | null;
  /** Server-derived force bit from the lease preview (GL-303). */
  requiresForce?: boolean;
}

/** The confirm content. Force is display-only — execute derives it from the lease. */
export interface RemoveWorktreeConfirm {
  title: string;
  message: string;
  details: string[];
  warnings: string[];
  confirmLabel: string;
  /** True when git would refuse an unforced remove — dirty, locked, or both. */
  force: boolean;
}

/** Pluralise a count. Handles the one irregular noun in use here ("entry"),
 * rather than pretending English is regular and printing "2 ignored entrys". */
const plural = (n: number, noun: string) =>
  `${n} ${n === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;

/** True when the probe found work that a removal would destroy.
 *
 * Ignored entries are excluded on purpose: git deletes them on an *unforced*
 * removal, so they neither make the worktree dirty nor require a force. They
 * are disclosed separately — see {@link describeIgnoredEntries}. */
export function hasUncommittedWork(dirty: WorktreeDirtyState | null): dirty is WorktreeDirtyState {
  return !!dirty && dirty.modified + dirty.untracked > 0;
}

/** A sentence disclosing ignored entries a removal would delete, or null when
 * there are none.
 *
 * Git's own model says ignored files are regenerable, which is why it deletes
 * them without a force — and why withholding a worktree over them would make
 * every JS checkout (`node_modules/`) permanently unremovable. But "ignored" is
 * not "worthless": a local `.env` is ignored too. Naming the count is the
 * difference between a cleanup and a silent loss. */
export function describeIgnoredEntries(dirty: WorktreeDirtyState | null): string | null {
  if (!dirty || dirty.ignored <= 0) return null;
  return `${plural(dirty.ignored, "ignored entry")} (such as build output or a local .env) will also be deleted. Git treats ignored files as regenerable, so this does not need a forced removal.`;
}

/** One phrase naming the uncommitted work, e.g. "29 modified files and 3
 * untracked files". Only the non-zero halves appear. */
export function describeUncommittedWork(dirty: WorktreeDirtyState): string {
  const parts: string[] = [];
  if (dirty.modified > 0) parts.push(plural(dirty.modified, "modified file"));
  if (dirty.untracked > 0) parts.push(plural(dirty.untracked, "untracked file"));
  return parts.join(" and ");
}

/** Build the removal confirm.
 *
 * The default stays *unforced* so git's own safety check applies. Force is
 * turned on only when this build knows git would otherwise refuse — the
 * worktree is dirty, locked, or both — and in that case the dialog says
 * plainly what is being given up rather than leaving the user to discover it
 * from a `fatal:` toast with no way forward (GL-296).
 */
export function buildRemoveWorktreeConfirm(
  subject: RemoveWorktreeSubject,
): RemoveWorktreeConfirm {
  const { name, path, branch, head, locked, dirty } = subject;
  const details = [`The linked worktree at ${path} will be removed.`];
  const warnings: string[] = [];

  // "Its branch and commits are kept" only holds when a branch anchors them. A
  // detached worktree's HEAD is the last thing keeping its commit reachable.
  if (branch) {
    details.push(`Its branch ${branch} and that branch's commits are kept.`);
  } else {
    warnings.push(
      `This worktree is detached (no branch) — its commit${
        head ? ` ${head.slice(0, 7)}` : ""
      } may become unreachable unless a branch or tag points to it.`,
    );
  }

  const uncommitted = hasUncommittedWork(dirty);
  if (uncommitted) {
    // Uncommitted work is the one loss with no recovery path: unlike a stranded
    // commit (reflog) or a deleted branch (reflog), it was never in the object
    // database at all. Say so explicitly.
    warnings.push(
      `${describeUncommittedWork(dirty)} in this worktree will be permanently deleted. This work was never committed, so it cannot be recovered afterwards.`,
    );
  }
  const ignoredNote = describeIgnoredEntries(dirty);
  if (ignoredNote) warnings.push(ignoredNote);
  if (locked) {
    warnings.push("This worktree is locked; removing it will override the lock.");
  }

  // A lock forces the removal on its own (`--force --force`), which also
  // overrides git's dirty check. So when the probe could not tell us whether
  // there is uncommitted work, a locked removal would destroy it having warned
  // only about the lock. That combination is not exotic — `git worktree lock`
  // exists for worktrees on removable or network volumes, which is exactly when
  // `git status` fails. Disclose the unknown rather than implying it is clean.
  // (Unlocked stays unforced, so git itself still refuses a dirty removal and
  // nothing can be lost silently there.)
  const unknownWork = dirty === null && locked;
  if (unknownWork) {
    warnings.push(
      "GitLane could not check this worktree for uncommitted changes. If it has any, removing it will permanently delete them.",
    );
  }

  const mayDestroyWork = uncommitted || unknownWork;
  const force = subject.requiresForce ?? (uncommitted || locked);
  return {
    title: `Remove worktree ${name}?`,
    message: uncommitted
      ? `${name} has uncommitted work that removing it would discard.`
      : `Remove the linked worktree ${name}?`,
    details,
    warnings,
    // Naming the destruction in the button keeps the discard from riding along
    // invisibly on a generic "Remove worktree" — including when the loss is
    // possible-but-unconfirmed.
    confirmLabel: mayDestroyWork ? "Remove and discard changes" : "Remove worktree",
    force,
  };
}
