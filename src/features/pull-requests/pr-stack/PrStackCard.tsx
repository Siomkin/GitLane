// The stack map shown on a stacked PR's Info tab, following GitHub's own stack
// card: a header stating what merging this PR would land, the layers top-first
// on a connector rail, and the base branch pinned at the bottom.
//
// Read-only for now — creating, restacking, and the atomic stack merge are
// separate operations against the stacks REST API.

import { useState } from "react";
import { cn } from "@/lib/cn";
import type { PrStack } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import { StackMergeButton } from "./StackMergeButton";
import { StackRow } from "./StackRow";
import { stackView } from "./stackModel";

function StackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

/** Plural-aware summary of what a stack merge from this layer would land. */
function headline(belowCount: number): { title: string; detail: string } {
  if (belowCount === 0) {
    return {
      title: "Bottom of a stack",
      detail: "This is the lowest unmerged layer — merging it lands only this pull request.",
    };
  }
  const layers = belowCount === 1 ? "1 pull request" : `${belowCount} pull requests`;
  return {
    title: "Able to merge as a stack",
    detail: `Merging this pull request will also merge ${layers} below it.`,
  };
}

// No `basic` provider flag here, unlike `PrMergeMenu`: stacks are GitHub-only,
// so this card never renders for GitLab or Bitbucket and all merge methods apply.
export function PrStackCard({ stack, pr }: { stack: PrStack; pr: PullRequest }) {
  const [open, setOpen] = useState(true);
  const view = stackView(stack, pr.num);
  // A stack the viewed PR isn't part of can't describe a merge from here; that
  // only happens if its own layer was filtered out of the entries.
  if (view.rows.length === 0) return null;
  const { title, detail } = headline(view.belowCount);
  // Offer the stack merge only when merging this PR is meaningful at all — the
  // same gate `PrActions` puts on the single-PR merge button, plus every layer
  // below being mergeable, since the operation is all-or-nothing.
  const canMerge =
    pr.state === "open" && !pr.draft && pr.mergeable !== "CONFLICTING" && !view.belowBlocked;

  return (
    <section className="overflow-hidden rounded-xl border border-black/5 dark:border-white/10">
      <div className="flex items-start gap-3 p-3.5">
        <span className="grid h-8 w-8 flex-none place-items-center rounded-full bg-[color:var(--accent)] text-white">
          <StackIcon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
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
      {canMerge && (
        <StackMergeButton prNum={pr.num} branch={pr.branch} mergeCount={view.mergeCount} />
      )}
    </section>
  );
}
