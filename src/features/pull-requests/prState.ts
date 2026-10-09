// PR state → presentation mapping. Pure (no React, no IPC): given a PR it
// returns the label + Tailwind class strings the header and Info stat-line share.
// Open reads as accent/green, merged as purple, closed as rose — the class-based
// palette that replaced the old per-state hex map.
import { PR_STATE, type PrState, type PrSummary } from "@/lib/prs";

const STATE_DOT: Record<PrState, string> = {
  open: "bg-emerald-500 dark:bg-emerald-400",
  merged: "bg-purple-500 dark:bg-purple-400",
  closed: "bg-rose-500 dark:bg-rose-400",
  other: "bg-neutral-400",
};
const STATE_TEXT: Record<PrState, string> = {
  open: "text-emerald-500 dark:text-emerald-400",
  merged: "text-purple-500 dark:text-purple-400",
  closed: "text-rose-500 dark:text-rose-400",
  other: "text-neutral-500 dark:text-neutral-400",
};
const STATE_LABEL: Record<PrState, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  other: "Other",
};

export interface PrStateView {
  label: string;
  dot: string;
  text: string;
}

// Draft PRs read as a distinct neutral state (open underneath); an unrecognised
// forge state shows its raw value ("MERGE_QUEUED" → "Merge queued"); everything else uses
// the semantic state maps above.
export function stateView(pr: PrSummary): PrStateView {
  if (pr.draft && pr.state === "open") {
    return {
      label: "Draft",
      dot: "bg-neutral-400",
      text: "text-neutral-500 dark:text-neutral-400",
    };
  }
  const raw = pr.state === PR_STATE.Other ? pr.rawState?.toLowerCase().replace(/[_-]+/g, " ").trim() : undefined;
  const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : STATE_LABEL[pr.state];
  return { label, dot: STATE_DOT[pr.state], text: STATE_TEXT[pr.state] };
}
