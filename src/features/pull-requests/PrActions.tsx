// PR detail header action cluster (right side of the meta row): GitHub, then
// the state actions — Reopen / Ready, the Merge split-button, and secondary
// actions in a "..." overflow menu.
// Write actions are gated by a confirm dialog and toast gh's result.

import { useRef, useState } from "react";
import { openExternalUrl } from "../../lib/openExternal";
import { cn } from "../../lib/cn";
import { ForgeKind, type MergeMethod } from "../../lib/api";
import type { PullRequest } from "../../lib/prs";
import { usePulls } from "../../store/pulls";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useDismiss } from "../../hooks/useDismiss";
import { BitbucketIcon, GitHubIcon, GitLabIcon } from "@/components/ui/icons";
import { InlineSpinner } from "@/components/ui/Loading";
import { useKeyedPrAction, useRunPrAction } from "./usePrAction";

const utilBtn =
  "grid h-9 w-9 place-items-center rounded-lg border border-black/10 text-neutral-600 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";
const outlineBtn =
  "flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:border-white/10 dark:text-neutral-200 dark:hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";

const MERGE_METHODS: { key: MergeMethod; label: string; sub: string }[] = [
  { key: "squash", label: "Squash and merge", sub: "Combine into one commit on base" },
  { key: "merge", label: "Create a merge commit", sub: "Keep all commits + a merge commit" },
  { key: "rebase", label: "Rebase and merge", sub: "Replay commits onto base" },
];

/** The full right-side action cluster for the PR detail header. GitLab (GL-145)
 * and Bitbucket (GL-141) are "basic" providers: the external link + icon follow
 * the forge, "Rebase and merge" is dropped (neither has a rebase-merge endpoint),
 * and the close/reopen/ready lifecycle actions are hidden — those aren't
 * implemented for GitLab MRs / Bitbucket PRs. Bitbucket keeps the "PR" noun. */
export const PrHeaderActions = ({ pr }: { pr: PullRequest }) => {
  const showToast = useUi((s) => s.showToast);
  const forge = useRepo((s) => s.forge);
  const isGitlab = forge?.kind === ForgeKind.GitLab;
  const isBitbucket = forge?.kind === ForgeKind.Bitbucket;
  // "Basic" PR providers: approve + merge (no rebase) + create, no lifecycle.
  const basic = isGitlab || isBitbucket;
  const forgeName = forge?.forge ?? "the remote";
  const ForgeIcon = isGitlab ? GitLabIcon : isBitbucket ? BitbucketIcon : GitHubIcon;
  const requestNoun = isGitlab ? "MR" : "PR";
  // Lifecycle (reopen/ready/close) is GitHub-only until the basic providers grow it.
  const hasStateActions = pr.state !== "merged" && !basic;

  return (
    <div className="ml-auto flex flex-none items-center gap-2">
      <button
        title={`Open on ${forgeName}`}
        onClick={() => {
          if (pr.url) openExternalUrl(pr.url);
          else showToast(`No ${forgeName} URL for this ${requestNoun}`, "error");
        }}
        className={utilBtn}
      >
        <ForgeIcon className="h-4 w-4" />
      </button>
      {hasStateActions && <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />}
      {!basic && <LifecycleControls pr={pr} />}
      {pr.state === "open" && !pr.draft && <MergeMenu pr={pr} basic={basic} />}
      <MoreMenu pr={pr} basic={basic} />
    </div>
  );
};

/** Reopen (closed) / Ready (draft) state buttons. Close lives in MoreMenu. */
const LifecycleControls = ({ pr }: { pr: PullRequest }) => {
  const setPrState = usePulls((s) => s.setPrState);
  const pending = usePulls((s) => s.prPendingActions.length > 0);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const { pendingKey, start } = useKeyedPrAction();

  if (pr.state === "closed") {
    return (
      <button
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
      <button
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

/** Merge split-button (label + chevron) with the strategy/delete-branch dropdown.
 * The basic providers (GitLab, Bitbucket) drop "Rebase and merge" — neither merge
 * endpoint has a rebase-merge strategy. */
const MergeMenu = ({ pr, basic }: { pr: PullRequest; basic: boolean }) => {
  const mergePr = usePulls((s) => s.mergePr);
  const methods = basic ? MERGE_METHODS.filter((m) => m.key !== "rebase") : MERGE_METHODS;
  // "Merging…" shows only while a merge is in flight, but the control disables
  // while ANY PR write runs so the user can't start a concurrent merge.
  const merging = usePulls((s) => s.prPendingActions.includes("merge"));
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
        <button
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
      // No fixed success message: depending on branch protection, gh may merge
      // now, enable auto-merge, or enqueue — let the runner toast gh's actual
      // first line rather than asserting "Merged".
      onConfirm: () => void run(() => mergePr(pr.num, method, deleteBranch)),
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
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
              <button
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

/** "..." overflow menu for secondary PR actions. "Checkout branch" is a local
 * git op (any forge); "Close" is GitHub-only — the basic providers (GitLab,
 * Bitbucket) don't implement close/reopen yet. */
const MoreMenu = ({ pr, basic }: { pr: PullRequest; basic: boolean }) => {
  const setPrState = usePulls((s) => s.setPrState);
  // Close is a PR write (setPrState); gate it on the same flag as the other
  // controls so a concurrent write can't start while one is already in flight.
  const busy = usePulls((s) => s.prPendingActions.length > 0);
  const checkoutBranch = useRepo((s) => s.checkoutBranch);
  const showToast = useUi((s) => s.showToast);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const { pendingKey, start } = useKeyedPrAction();
  const [open, setOpen] = useState(false);
  // Checkout is a repo write (not a `gh` PR action), so it tracks its own
  // pending flag and keeps the menu open while it runs to host the spinner.
  const [checkingOut, setCheckingOut] = useState(false);
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
      <button
        title={pendingKey === "close" ? "Closing pull request…" : "More actions"}
        onClick={() => setOpen((o) => !o)}
        // Close runs after the menu has dismissed, so the overflow trigger is the
        // only control left on screen to host its in-flight feedback.
        disabled={pendingKey === "close"}
        aria-busy={pendingKey === "close"}
        className={utilBtn}
      >
        {pendingKey === "close" ? (
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
          <button
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
            <button
              disabled={busy}
              onClick={() => {
                setOpen(false);
                requestConfirm({
                  title: `Close pull request #${pr.num}?`,
                  message: "You can reopen it later.",
                  confirmLabel: "Close pull request",
                  danger: true,
                  onConfirm: () => void start("close", () => setPrState(pr.num, "close"), `Closed #${pr.num}`),
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
