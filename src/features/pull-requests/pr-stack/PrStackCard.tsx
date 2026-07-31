// The stack map shown on a stacked PR's Info tab, following GitHub's own stack
// card: a header stating what merging this PR would land, the layers top-first
// on a connector rail, and the base branch pinned at the bottom.
//
// The footer runs GitHub's atomic stack merge. Creating and restacking are
// separate operations against the stacks REST API and are not wired up here.

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { PrStack } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import { StackMergeButton } from "./StackMergeButton";
import { StackRow } from "./StackRow";
import { stackView, type StackView } from "./stackModel";
import { useStackMergePending } from "./useStackMergePending";

/** Layers mark, with the small ✕ GitHub adds when the stack can't be merged. */
function StackIcon({ className, blocked }: { className?: string; blocked?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      {blocked ? <path d="m15 15 5 5m0-5-5 5" /> : <path d="m3 13 9 5 9-5" />}
    </svg>
  );
}

/** Plural-aware summary of what a stack merge from this layer would land.
 *
 * Mirrors GitHub's own three states: blocked, bottom-of-stack, and able to
 * merge. The blocked wording has to come first — saying "able to merge as a
 * stack" above a layer marked Not ready is exactly the contradiction GitHub
 * avoids. */
function headline(view: StackView, merging: boolean): {
  title: string;
  detail: string;
  blocked: boolean;
} {
  // First, ahead of every other state: while the merge runs, "Able to merge as a
  // stack" above rows marked Merging is the same contradiction the copy below
  // avoids, and the readiness that was true a moment ago is now moot.
  if (merging) {
    const layers = view.mergeCount === 1 ? "1 pull request is" : `${view.mergeCount} pull requests are`;
    return { title: "Merging stack…", detail: `${layers} being merged.`, blocked: false };
  }
  if (view.blockReason === "layer") {
    return {
      title: "Unable to merge as a stack",
      detail: "Some of the pull requests in this stack cannot be merged.",
      blocked: true,
    };
  }
  if (view.blockReason === "partial") {
    return {
      title: "Unable to merge as a stack",
      // Not the same claim as "cannot be merged" — we simply can't see every
      // layer, and an unseen one could block an all-or-nothing merge.
      detail: "Some layers of this stack aren't visible, so it can't be merged from here.",
      blocked: true,
    };
  }
  if (view.belowCount === 0) {
    return {
      title: "Bottom of a stack",
      detail: "This is the lowest unmerged layer — merging it lands only this pull request.",
      blocked: false,
    };
  }
  const layers = view.belowCount === 1 ? "1 pull request" : `${view.belowCount} pull requests`;
  return {
    title: "Able to merge as a stack",
    detail: `Merging this pull request will also merge ${layers} below it.`,
    blocked: false,
  };
}

// No `basic` provider flag here, unlike `PrMergeMenu`: stacks are GitHub-only,
// so this card never renders for GitLab or Bitbucket and all merge methods apply.
export function PrStackCard({ stack, pr }: { stack: PrStack; pr: PullRequest }) {
  const [open, setOpen] = useState(true);
  // `mergeStack` holds one IPC call open for the whole poll, so this flag tracks
  // the real operation for its whole duration.
  const merging = useStackMergePending(pr.num);
  const view = stackView(stack, pr.num, merging);
  // A stack the viewed PR isn't part of can't describe a merge from here — it
  // would render someone else's layers with a zero-count merge control. That
  // happens when its own entry was filtered out (an unreadable PR), so check
  // for the row rather than just for *any* rows.
  if (view.rows.length === 0 || !view.currentFound) return null;
  const { title, detail, blocked } = headline(view, merging);
  // The merge control shows for any open, non-draft PR in a stack; whether it
  // is *enabled* is `blocked`. GitHub greys it rather than hiding it, so the
  // reason stays visible next to the action it disables.
  const showMerge = pr.state === "open" && !pr.draft;

  return (
    <section className="overflow-hidden rounded-xl border border-black/5 dark:border-white/10">
      <div className="flex items-start gap-3 p-3.5">
        <span
          className={cn(
            "grid h-8 w-8 flex-none place-items-center rounded-full text-white",
            blocked ? "bg-rose-600 dark:bg-rose-500" : "bg-[color:var(--accent)]",
          )}
        >
          <StackIcon className="h-[18px] w-[18px]" blocked={blocked} />
        </span>
        {/* Live region so the flip to "Merging stack…" is announced — the pills
            below change silently, and the footer button's `aria-busy` alone
            doesn't say what is happening. `role="status"` already implies
            `aria-live="polite"`. */}
        <div className="min-w-0 flex-1" role="status" aria-busy={merging}>
          <div className="text-[13.5px] font-semibold text-neutral-900 dark:text-neutral-50">{title}</div>
          <div className="mt-0.5 text-[12.5px] leading-snug text-neutral-500 dark:text-neutral-400">
            {detail}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Collapse stack" : "Expand stack"}
          className="grid h-6 w-6 flex-none place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={cn("h-4 w-4 transition-transform", !open && "rotate-180")}>
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>
      </div>

      {open && (
        <div className="border-t border-black/5 py-1 dark:border-white/10">
          {view.rows.map((row, i) => (
            <StackRow key={row.entry.number} row={row} last={i === view.rows.length - 1} />
          ))}
          {/* The trunk the stack sits on — not a layer, so it gets the hollow
              marker and a ref chip rather than a status pill. */}
          <div className="flex items-center gap-2.5 py-2 pl-3 pr-3">
            <span className="grid h-[15px] w-[15px] flex-none place-items-center">
              <span className="h-[9px] w-[9px] rounded-full border-[1.5px] border-neutral-400" />
            </span>
            <span className="rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11.5px] text-neutral-600 dark:bg-white/[0.08] dark:text-neutral-300">
              {view.baseRef}
            </span>
          </div>
          {view.partial && (
            <div className="px-3 pb-2 pt-1 text-[11.5px] text-neutral-400">
              Showing {view.rows.length} of {stack.size} layers.
            </div>
          )}
        </div>
      )}
      {showMerge && (
        <StackMergeButton
          prNum={pr.num}
          branch={pr.branch}
          mergeCount={view.mergeCount}
          blocked={blocked}
        />
      )}
    </section>
  );
}
