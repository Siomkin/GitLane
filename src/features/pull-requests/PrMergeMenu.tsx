import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import type { MergeMethod } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useUi } from "@/store/ui";
import { useDismiss } from "@/hooks/useDismiss";
import { InlineSpinner } from "@/components/ui/Loading";
import { useRunPrAction } from "./usePrAction";

export const MERGE_METHODS: { key: MergeMethod; label: string; sub: string }[] = [
  { key: "squash", label: "Squash and merge", sub: "Combine into one commit on base" },
  { key: "merge", label: "Create a merge commit", sub: "Keep all commits + a merge commit" },
  { key: "rebase", label: "Rebase and merge", sub: "Replay commits onto base" },
];

/** Merge split-button (label + chevron) with the strategy/delete-branch dropdown.
 * The basic providers (GitLab, Bitbucket) drop "Rebase and merge" — neither merge
 * endpoint has a rebase-merge strategy. */
export const PrMergeMenu = ({ pr, basic }: { pr: PullRequest; basic: boolean }) => {
  const mergePr = usePulls((s) => s.mergePr);
  const methods = basic ? MERGE_METHODS.filter((m) => m.key !== "rebase") : MERGE_METHODS;
  // "Merging…" shows only while a merge is in flight, but the control disables
  // while ANY PR write runs so the user can't start a concurrent merge.
  const merging = usePulls((s) =>
    s.prPendingActions.some((pending) =>
      pending.action === PR_PENDING_ACTION.Merge && pending.prNum === pr.num
    ),
  );
  const busy = usePulls((s) => s.prPendingActions.length > 0);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const run = useRunPrAction();
  const [open, setOpen] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  if (pr.mergeable === "CONFLICTING") {
    return (
      <div className="group relative">
        <button type="button"
          disabled
          className="flex h-9 cursor-not-allowed items-center gap-1.5 rounded-lg bg-black/[0.06] px-3.5 text-[13px] font-medium text-neutral-400 dark:bg-white/10"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          Conflicts
        </button>
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 hidden w-[230px] rounded-lg bg-neutral-900 px-3 py-2 text-[12px] leading-snug text-white shadow-[0_12px_30px_-8px_rgba(0,0,0,0.5)] group-hover:block dark:bg-neutral-700">
          This branch has conflicts that must be resolved.
        </div>
      </div>
    );
  }

  const doMerge = (method: MergeMethod) => {
    setOpen(false);
    const label = MERGE_METHODS.find((m) => m.key === method)?.label ?? "Merge";
    requestConfirm({
      title: `Merge pull request #${pr.num}?`,
      message: deleteBranch
        ? `${label}, then delete the ${pr.branch} branch. This can't be undone.`
        : `${label}. This can't be undone.`,
      confirmLabel: "Merge",
      // Success is silent (the PR list updates). Depending on branch protection,
      // gh may merge now, enable auto-merge, or enqueue — so nothing here claims
      // "Merged"; the store only speaks up when a *confirmed* merge left the head
      // branch undeleted (GL-345).
      onConfirm: () => void run(() => mergePr(pr.num, method, deleteBranch)),
    });
  };

  return (
    <div ref={ref} className="relative">
      <button type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-busy={merging}
        className="flex h-9 items-center rounded-lg bg-emerald-600 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45 dark:bg-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
      >
        <span className="flex items-center gap-1.5 pl-3.5 pr-2.5">
          {merging ? (
            <>
              <InlineSpinner className="h-3.5 w-3.5" />
              Merging…
            </>
          ) : (
            <>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
                <circle cx="6" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M6 9v6M18 6a3 3 0 0 1-3 3H9" />
              </svg>
              Merge
            </>
          )}
        </span>
        <span className="my-1.5 w-px self-stretch bg-white/30" />
        <span className="flex items-center px-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="gp-pop absolute right-0 top-[calc(100%+6px)] z-50 w-[260px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_22px_50px_-10px_rgba(0,0,0,0.45)] dark:border-white/10 dark:bg-neutral-800">
          <div className="p-1.5">
            {methods.map((m) => (
              <button type="button"
                key={m.key}
                onClick={() => doMerge(m.key)}
                disabled={busy}
                className="w-full rounded-lg px-2.5 py-2 text-left hover:bg-black/5 disabled:opacity-50 dark:hover:bg-white/5"
              >
                <div className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">{m.label}</div>
                <div className="text-[12px] text-neutral-400">{m.sub}</div>
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer select-none items-center gap-2 border-t border-black/5 px-3 py-2.5 dark:border-white/5">
            <span
              className={cn(
                "grid h-4 w-4 place-items-center rounded border",
                deleteBranch
                  ? "border-[color:var(--accent)] bg-[var(--accent)] text-white"
                  : "border-black/20 dark:border-white/20",
              )}
            >
              {deleteBranch && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-2.5 w-2.5">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
            <input
              type="checkbox"
              checked={deleteBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
              className="sr-only"
            />
            <span className="text-[12.5px] text-neutral-600 dark:text-neutral-300">Delete branch after merge</span>
          </label>
        </div>
      )}
    </div>
  );
};
