// Collapsed-by-default list of the commits the pull request would carry.
// Collapsed because the counts in the header answer the usual question and the
// dialog is already tall; expanded it is the honest check of what the chosen
// base actually includes.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { relativeSince } from "@/lib/prs";
import type { HistorySearchResult } from "@/lib/api";

export function CommitsPanel({
  commits,
  loading,
  failed,
  note,
}: {
  commits: HistorySearchResult[];
  loading: boolean;
  /** The range read failed. Kept apart from an empty list because "nothing to
   * merge" is a claim about the branch, and it is not true here. */
  failed: boolean;
  /** Right-aligned context, e.g. what the layers below contribute. */
  note: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 bg-black/[0.02] px-3 hover:bg-black/[0.04] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 text-neutral-400 transition-transform", open && "rotate-90")}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-400">
          {/* A count is an answer; don't print "0 commits" for a read that failed. */}
          {loading || failed
            ? "Commits"
            : `${commits.length} ${commits.length === 1 ? "commit" : "commits"}`}
        </span>
        <span className="ml-auto text-[11.5px] text-neutral-400">{note}</span>
      </button>
      {open && (
        <div className="max-h-[136px] overflow-auto border-t border-black/5 dark:border-white/5">
          {commits.length === 0 ? (
            <div className="px-3 py-2.5 text-[12.5px] text-neutral-400">
              {loading
                ? "Reading commits…"
                : failed
                  ? "Couldn't read the commits for this range — check the base branch resolves."
                  : "Nothing to merge — the base already has this branch."}
            </div>
          ) : (
            commits.map((commit) => (
              <div
                key={commit.id}
                className="flex h-[34px] items-center gap-3 border-b border-black/5 px-3 last:border-0 dark:border-white/5"
              >
                <span className="w-[58px] shrink-0 font-mono text-[12px] text-neutral-400">
                  {commit.shortId}
                </span>
                <span className="truncate text-[13px] text-neutral-700 dark:text-neutral-200">
                  {commit.summary}
                </span>
                <span className="ml-auto shrink-0 text-[11.5px] text-neutral-400">
                  {relativeSince(commit.timestamp * 1000)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
