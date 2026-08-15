import { PR_PENDING_ACTION, anyPrActionPending, isPrActionPending, usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
import { InlineSpinner } from "@/components/ui/Loading";
import type { PrSummary } from "@/lib/prs";
import { PR_ACTION_KEY, useKeyedPrAction } from "./usePrAction";
import { outlineBtn } from "./prActionStyles";

/** Reopen (closed) / Ready (draft) state buttons. Close lives in PrMoreMenu. */
export const PrLifecycleControls = ({ pr }: { pr: PrSummary }) => {
  const setPrState = usePulls((s) => s.setPrState);
  const pending = usePulls(anyPrActionPending());
  const expectedStateAction = pr.state === "closed" ? "reopen" : pr.state === "open" && pr.draft ? "ready" : null;
  // Hooks run even for states this control renders nothing for (e.g. merged),
  // where there is no expected verb — nothing can be pending *for this button*
  // then, so the selector is a constant false rather than a verb-less match.
  const statePending = usePulls(
    expectedStateAction
      ? isPrActionPending(PR_PENDING_ACTION.State, pr.num, { stateAction: expectedStateAction })
      : () => false,
  );
  const requestConfirm = useUi((s) => s.requestConfirm);
  const { pendingKey, start } = useKeyedPrAction();

  if (pr.state === "closed") {
    const reopening = pendingKey === PR_ACTION_KEY.Reopen || statePending;
    return (
      <button type="button"
        disabled={pending}
        aria-busy={reopening}
        onClick={() =>
          requestConfirm({
            title: `Reopen pull request #${pr.num}?`,
            message: "This will move the PR back to open.",
            confirmLabel: "Reopen",
            onConfirm: () => void start(PR_ACTION_KEY.Reopen, () => setPrState(pr.num, "reopen")),
          })
        }
        className={outlineBtn}
      >
        {reopening ? (
          <InlineSpinner className="h-4 w-4" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
          </svg>
        )}
        {reopening ? "Reopening…" : "Reopen"}
      </button>
    );
  }
  if (pr.state === "open" && pr.draft) {
    const markingReady = pendingKey === PR_ACTION_KEY.Ready || statePending;
    return (
      <button type="button"
        disabled={pending}
        aria-busy={markingReady}
        onClick={() =>
          requestConfirm({
            title: `Mark #${pr.num} ready for review?`,
            message: "This takes the PR out of draft so it can be reviewed and merged.",
            confirmLabel: "Ready for review",
            onConfirm: () => void start(PR_ACTION_KEY.Ready, () => setPrState(pr.num, "ready")),
          })
        }
        className={outlineBtn}
      >
        {markingReady ? (
          <InlineSpinner className="h-4 w-4" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
        {markingReady ? "Marking ready…" : "Ready"}
      </button>
    );
  }
  return null;
};
