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
    // Refs stay out of the title and button: long branch names have no spaces
    // to wrap at. The facts name both, and which one git checks out.
    title: "Rebase branch?",
    message: "Rewrites history: the branch's commits are replayed with new hashes.",
    icon: "branch",
    facts: request.needsCheckout
      ? [
          { label: "1. Check out", value: request.source, kind: "ref" },
          { label: "2. Replay its commits onto", value: request.onto, kind: "ref" },
        ]
      : [
          { label: "Replay commits from", value: request.source, kind: "ref" },
          { label: "Onto", value: request.onto, kind: "ref" },
        ],
    confirmLabel: request.needsCheckout ? "Check out and rebase" : "Rebase",
    onConfirm: request.proceed,
  });
}
