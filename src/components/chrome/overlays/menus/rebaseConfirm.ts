import type { ConfirmRequest } from "@/store/ui";

interface RebaseConfirmRequest {
  /** Branch/revision that will be replayed. */
  source: string;
  /** User-facing target label (branch name or short commit oid). */
  onto: string;
  /** Whether Git must switch the worktree to `source` first. */
  needsCheckout: boolean;
  requestConfirm: (request: ConfirmRequest) => void;
  proceed: () => void;
}

/** Rebase always gets an exact source/target confirmation. Besides making a
 * history rewrite explicit, this keeps a stale or mistaken graph drop from
 * silently replaying the right branch onto the wrong target. The backend then
 * carries the same source and target through one git process. */
export function confirmRebase(request: RebaseConfirmRequest): void {
  request.requestConfirm({
    title: `Rebase ${request.source} onto ${request.onto}?`,
    message: request.needsCheckout
      ? `Check out branch "${request.source}", then replay its commits onto "${request.onto}".`
      : `Replay commits from "${request.source}" onto "${request.onto}".`,
    // The title names two branches, so a bare "Check out and rebase" reads as
    // "check out the target" — alarming when the target is the branch you are
    // already on. Name the branch git actually switches to.
    confirmLabel: request.needsCheckout
      ? `Check out ${request.source} and rebase`
      : "Rebase",
    onConfirm: request.proceed,
  });
}
