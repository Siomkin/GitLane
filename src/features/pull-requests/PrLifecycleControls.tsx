import { usePulls } from "../../store/pulls";
import { useUi } from "../../store/ui";
import { InlineSpinner } from "@/components/ui/Loading";
import type { PullRequest } from "../../lib/prs";
import { useKeyedPrAction } from "./usePrAction";
import { outlineBtn } from "./prActionStyles";

/** Reopen (closed) / Ready (draft) state buttons. Close lives in PrMoreMenu. */
export const PrLifecycleControls = ({ pr }: { pr: PullRequest }) => {
  const setPrState = usePulls((s) => s.setPrState);
  const pending = usePulls((s) => s.prPendingActions.length > 0);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const { pendingKey, start } = useKeyedPrAction();

  if (pr.state === "closed") {
    return (
      <button type="button"
        disabled={pending}
        aria-busy={pendingKey === "reopen"}
        onClick={() =>
          requestConfirm({
            title: `Reopen pull request #${pr.num}?`,
            message: "This will move the PR back to open.",
            confirmLabel: "Reopen",
            onConfirm: () => void start("reopen", () => setPrState(pr.num, "reopen"), `Reopened #${pr.num}`),
          })
        }
        className={outlineBtn}
      >
        {pendingKey === "reopen" ? (
          <InlineSpinner className="h-4 w-4" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" />
          </svg>
        )}
        {pendingKey === "reopen" ? "Reopening…" : "Reopen"}
      </button>
    );
  }
  if (pr.state === "open" && pr.draft) {
    return (
      <button type="button"
        disabled={pending}
        aria-busy={pendingKey === "ready"}
        onClick={() =>
          requestConfirm({
            title: `Mark #${pr.num} ready for review?`,
            message: "This takes the PR out of draft so it can be reviewed and merged.",
            confirmLabel: "Ready for review",
            onConfirm: () => void start("ready", () => setPrState(pr.num, "ready"), `#${pr.num} ready for review`),
          })
        }
        className={outlineBtn}
      >
        {pendingKey === "ready" ? (
          <InlineSpinner className="h-4 w-4" />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        )}
        {pendingKey === "ready" ? "Marking ready…" : "Ready"}
      </button>
    );
  }
  return null;
};
