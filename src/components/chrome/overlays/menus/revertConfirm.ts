import type { ConfirmRequest } from "@/store/ui";

interface RevertConfirmBase {
  /** Branch the revert commits land on (or "HEAD" when detached). */
  branch: string;
  requestConfirm: (request: ConfirmRequest) => void;
  proceed: () => void;
}

/** One commit names its short oid; a batch names how many — never both. */
type RevertConfirmRequest = RevertConfirmBase & ({ shortSha: string } | { count: number });

/** Revert writes commits — it isn't a view change — and it sits one row away
 * from Cherry-pick and Reset in the same menus, so a mis-aimed click used to
 * commit straight to the checked-out branch. Confirm first, naming both the
 * target commit(s) and the branch the new commits land on. Not danger-toned:
 * revert adds history rather than destroying it, unlike reset or a delete. */
export function confirmRevert(request: RevertConfirmRequest): void {
  request.requestConfirm(
    "count" in request
      ? {
          title: `Revert ${request.count} commits?`,
          message: `Adds ${request.count} new commits to "${request.branch}" that undo their changes, newest first. The original commits stay in history.`,
          confirmLabel: "Revert",
          onConfirm: request.proceed,
        }
      : {
          title: `Revert commit ${request.shortSha}?`,
          message: `Adds a new commit to "${request.branch}" that undoes the changes in ${request.shortSha}. The original commit stays in history.`,
          confirmLabel: "Revert",
          onConfirm: request.proceed,
        },
  );
}
