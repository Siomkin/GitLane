// The in-flight checkout of one repository: what the store records while it
// runs, how a graph ref pill matches it, and the error a refused request gets.

import { RefKind, type RefLabel } from "@/lib/api";
import { trimTrailingSeparators } from "@/lib/paths";

/** What a running checkout acted on. `local` is a name git resolves itself (a
 *  branch, or a tag when no branch has that name); `remote` a remote-tracking
 *  ref (`origin/develop`); `commit` a detached commit id. */
export interface PendingCheckoutRef {
  ref: string;
  kind: "local" | "remote" | "commit";
}

/** The `checkoutPending` key for a repository or worktree path. */
export const checkoutKey = (path: string) => trimTrailingSeparators(path);

/** How the running checkout reads in a message: the short id for a commit. */
export const pendingRefLabel = (pending: PendingCheckoutRef) =>
  pending.kind === "commit" ? pending.ref.slice(0, 7) : pending.ref;

/** Whether `label`'s pill is the ref being checked out. A tag matches a local
 *  checkout only when no local branch has its name, because git switches to
 *  the branch in that case. */
export function pendingMatchesLabel(
  pending: PendingCheckoutRef,
  label: RefLabel,
  hasLocalBranch: (name: string) => boolean,
): boolean {
  if (pending.ref !== label.name) return false;
  switch (label.kind) {
    case RefKind.Remote:
      return pending.kind === "remote";
    case RefKind.Branch:
      return pending.kind === "local";
    case RefKind.Tag:
      return pending.kind === "local" && !hasLocalBranch(label.name);
    default:
      return false;
  }
}

/** A checkout, or a write that switches the working tree, asked for while a
 *  checkout runs in the same repository. A repeat double-click on the pill
 *  being checked out drops it silently; every other caller shows it. */
export class CheckoutBusyError extends Error {
  readonly running: PendingCheckoutRef;
  constructor(running: PendingCheckoutRef) {
    super(`A checkout of ${pendingRefLabel(running)} is already running. Try again when it finishes.`);
    this.name = "CheckoutBusyError";
    this.running = running;
  }
}
