import type { ConfirmRequest } from "@/store/ui";

export interface CheckoutPrereqRequest {
  /** Currently checked-out branch, or null when detached/unknown. */
  headBranch: string | null;
  /** Local branch the operation must check out before it can run. */
  branch: string;
  /** The requested operation, phrased for "To <operation>, …" (e.g.
   * `rebase feature onto main`). */
  operation: string;
  /** Confirm-button label naming the combined action (e.g. "Check out and
   * rebase") — never a generic "Yes". */
  confirmLabel: string;
  requestConfirm: (req: ConfirmRequest) => void;
  /** Runs the approved flow: the checkout prerequisite, then the operation. */
  proceed: () => void;
}

/** GL-217 — an operation that must first check out another branch never
 * switches the working tree silently. When `branch` is already checked out
 * there is no prerequisite and `proceed` runs directly (no popup); otherwise
 * the user approves the combined checkout-plus-operation flow first, and
 * cancelling leaves the repository untouched. */
export function confirmCheckoutPrereq(req: CheckoutPrereqRequest): void {
  if (req.headBranch === req.branch) {
    req.proceed();
    return;
  }
  req.requestConfirm({
    title: `Check out ${req.branch}?`,
    message: `To ${req.operation}, GitLane must check out branch "${req.branch}". Do you want to continue?`,
    confirmLabel: req.confirmLabel,
    onConfirm: req.proceed,
  });
}
