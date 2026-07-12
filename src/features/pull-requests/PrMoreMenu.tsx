import { useRef, useState } from "react";
import type { PullRequest } from "@/lib/prs";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { InlineSpinner } from "@/components/ui/Loading";
import { PR_ACTION_KEY, useKeyedPrAction } from "./usePrAction";
import { utilBtn } from "./prActionStyles";

/** "..." overflow menu for secondary PR actions. "Checkout branch" is a local
 * git op (any forge); "Close" is GitHub-only — the basic providers (GitLab,
 * Bitbucket) don't implement close/reopen yet. */
export const PrMoreMenu = ({ pr, basic }: { pr: PullRequest; basic: boolean }) => {
  const setPrState = usePulls((s) => s.setPrState);
  // Close is a PR write (setPrState); gate it on the same flag as the other
  // controls so a concurrent write can't start while one is already in flight.
  const busy = usePulls((s) => s.prPendingActions.length > 0);
  const statePending = usePulls((s) =>
    s.prPendingActions.some((pending) =>
      pending.action === PR_PENDING_ACTION.State &&
      pending.prNum === pr.num &&
      pending.stateAction === "close"
    ),
  );
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const { pendingKey, start } = useKeyedPrAction();
  const [open, setOpen] = useState(false);
  // Checkout is a repo write (not a `gh` PR action), so it tracks its own
  // pending flag. The trigger hosts feedback if the menu is dismissed while it runs.
  const [checkingOut, setCheckingOut] = useState(false);
  const closing = pendingKey === PR_ACTION_KEY.Close || statePending;
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  const runCheckout = async () => {
    if (checkingOut) return;
    setCheckingOut(true);
    try {
      await checkoutBranch(pr.branch);
      setOpen(false);
    } catch (e) {
      showToast(String(e), "error");
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button type="button"
        title={
          closing
            ? "Closing pull request…"
            : checkingOut
              ? "Checking out branch…"
              : "More actions"
        }
        onClick={() => setOpen((o) => !o)}
        // Close runs after the menu has dismissed, so the overflow trigger is the
        // only control left on screen to host its in-flight feedback.
        disabled={closing || checkingOut}
        aria-busy={closing || checkingOut}
        className={utilBtn}
      >
        {closing || checkingOut ? (
          <InlineSpinner className="h-4 w-4" />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
            <circle cx="12" cy="5" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="12" cy="19" r="1.6" />
          </svg>
        )}
      </button>
      {open && (
        <div className="gp-pop absolute right-0 top-[calc(100%+6px)] z-50 w-[208px] overflow-hidden rounded-xl border border-black/10 bg-white py-1.5 shadow-[0_22px_50px_-10px_rgba(0,0,0,0.45)] dark:border-white/10 dark:bg-neutral-800">
          <button type="button"
            onClick={() => void runCheckout()}
            disabled={checkingOut}
            className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium text-neutral-700 transition-colors hover:bg-black/5 disabled:opacity-45 disabled:hover:bg-transparent dark:text-neutral-200 dark:hover:bg-white/5"
          >
            {checkingOut ? (
              <InlineSpinner className="h-4 w-4" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M12 3v12" />
                <path d="m7 11 5 5 5-5" />
                <path d="M5 21h14" />
              </svg>
            )}
            {checkingOut ? "Checking out…" : "Checkout branch"}
          </button>
          {pr.state === "open" && !basic && <div className="my-1 h-px bg-black/5 dark:bg-white/5" />}
          {pr.state === "open" && !basic && (
            <button type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                requestConfirm({
                  title: `Close pull request #${pr.num}?`,
                  message: "You can reopen it later.",
                  confirmLabel: "Close pull request",
                  danger: true,
                  onConfirm: () => void start(PR_ACTION_KEY.Close, () => setPrState(pr.num, "close"), `Closed #${pr.num}`),
                });
              }}
              className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] font-medium text-rose-600 transition-colors hover:bg-rose-500/10 disabled:opacity-45 disabled:hover:bg-transparent dark:text-rose-400"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              Close pull request
            </button>
          )}
        </div>
      )}
    </div>
  );
};
