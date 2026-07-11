// PR metadata strip (the center-pane equivalent of GitHub's right sidebar).
// Collapsed by default to Reviewers + Assignees; a chevron on the first of those
// rows expands Labels, Milestone, and People. When neither reviewers nor
// assignees exist there's no row to host the chevron, so the extras (if any)
// render inline. The whole strip is hidden when a PR has no meaningful metadata
// — note `participants` always includes the author, so it alone doesn't count.
// Each editable row has a gear/+ that opens a "Planned" popover — editing is
// read-only for now (display only).

import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import type { PrAuthor, PullRequest, Reviewer, ReviewerState } from "../../lib/prs";
import { useDismiss } from "../../hooks/useDismiss";

const REVIEW_DOT: Record<ReviewerState, string> = {
  approved: "bg-emerald-500",
  changes_requested: "bg-rose-500",
  commented: "bg-neutral-400",
  pending: "bg-amber-400",
};
const REVIEW_LABEL: Record<ReviewerState, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  commented: "commented",
  pending: "pending",
};

const metaGear =
  "grid h-6 w-6 place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]";

const isBot = (name: string) => name.toLowerCase().endsWith("[bot]");

export function PrMeta({ pr }: { pr: PullRequest }) {
  const [expanded, setExpanded] = useState(false);
  const hasReviewers = pr.reviewers.length > 0;
  const hasAssignees = pr.assignees.length > 0;
  const hasLabels = pr.labels.length > 0;
  const hasMilestone = !!pr.milestone;
  // `participants` always includes the PR author, so only count it as "people"
  // worth showing once someone else is involved (a reviewer/assignee/commenter).
  const hasPeople = pr.participants.length > 1;
  const hasMore = hasLabels || hasMilestone || hasPeople;
  const hasPrimary = hasReviewers || hasAssignees;

  // Nothing meaningful to show — don't render an empty strip. Without this a
  // solo/self-merged PR (no reviewers/assignees/labels/milestone) rendered an
  // empty bordered box: the only truthy field was the author-in-participants,
  // and the extras were gated behind a chevron that only the Reviewers row hosts.
  if (!hasPrimary && !hasMore) return null;

  // The expand chevron lives on the first primary row; with no primary row to
  // host it, reveal the extras inline rather than trapping them behind a chevron
  // that never renders.
  const showMore = expanded || !hasPrimary;
  const moreToggle = hasMore ? (
    <button type="button"
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? "Show less" : "Show more"}
      className={cn("ml-auto self-center", metaGear)}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  ) : null;

  return (
    <div className="space-y-3 rounded-xl border border-black/5 bg-black/[0.02] p-4 dark:border-white/5 dark:bg-white/[0.02]">
      {hasReviewers && (
        <Row label="Reviewers">
          {pr.reviewers.map((r) => (
            <ReviewerChip key={r.name} reviewer={r} />
          ))}
          <PlannedPicker title="Request reviewers" />
          {moreToggle}
        </Row>
      )}
      {hasAssignees && (
        <Row label="Assignees">
          {pr.assignees.map((a) => (
            <PersonChip key={a.name} person={a} />
          ))}
          <PlannedPicker title="Assign people" />
          {!hasReviewers && moreToggle}
        </Row>
      )}
      {showMore && hasLabels && (
        <Row label="Labels">
          {pr.labels.map((l) => (
            <span
              key={l.name}
              className="flex h-7 items-center rounded-full border border-black/5 bg-black/[0.04] px-2.5 text-[12px] font-medium text-neutral-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-300"
              style={{ borderColor: `#${l.color || "d4d4d4"}` }}
            >
              {l.name}
            </span>
          ))}
          <PlannedPicker title="Apply labels" />
        </Row>
      )}
      {showMore && hasMilestone && (
        <Row label="Milestone">
          <span className="flex items-center gap-1.5 text-[13px] text-neutral-700 dark:text-neutral-200">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 flex-none text-neutral-400">
              <path d="M4 21V4a1 1 0 0 1 1-1h11l-2 4 2 4H5" />
            </svg>
            {pr.milestone}
          </span>
          <PlannedPicker title="Set milestone" />
        </Row>
      )}
      {showMore && hasPeople && (
        <Row label="People">
          <div className="flex items-center">
            {pr.participants.map((p) => (
              <span key={p.name} className="-ml-1 first:ml-0" title={p.name}>
                <span
                  className={cn(
                    "grid h-6 w-6 place-items-center rounded-md text-[9px] font-semibold text-white ring-2 ring-[#faf9f6] dark:ring-neutral-800",
                    isBot(p.name) ? "bg-violet-500" : "bg-[var(--accent)]",
                  )}
                >
                  {p.initials}
                </span>
              </span>
            ))}
          </div>
        </Row>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[72px] flex-none text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function PersonChip({ person }: { person: PrAuthor }) {
  return (
    <span className="flex h-7 items-center gap-1.5 rounded-full bg-black/[0.04] pl-1 pr-2.5 dark:bg-white/[0.06]">
      <Avatar person={person} />
      <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">{person.name}</span>
    </span>
  );
}

function ReviewerChip({ reviewer }: { reviewer: Reviewer }) {
  return (
    <span
      className="flex h-7 items-center gap-1.5 rounded-full bg-black/[0.04] pl-1 pr-2.5 dark:bg-white/[0.06]"
      title={REVIEW_LABEL[reviewer.state]}
    >
      <Avatar person={reviewer} />
      <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">{reviewer.name}</span>
      <span className={cn("h-2 w-2 rounded-full", REVIEW_DOT[reviewer.state])} />
    </span>
  );
}

function Avatar({ person }: { person: { name: string; initials: string } }) {
  if (isBot(person.name)) {
    return (
      <span className="grid h-5 w-5 flex-none place-items-center rounded-md bg-violet-500 text-white">
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
          <path d="M12 3l1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4z" />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="grid h-5 w-5 flex-none place-items-center rounded-md text-[9px] font-semibold text-white"
      style={{ background: "var(--accent)" }}
    >
      {person.initials}
    </span>
  );
}

/** The gear/+ affordance that opens a "Planned — editing is read-only" popover. */
function PlannedPicker({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} title={title} className={metaGear}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && (
        <div className="gp-pop absolute left-0 top-[calc(100%+6px)] z-50 w-[244px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_22px_50px_-10px_rgba(0,0,0,0.45)] dark:border-white/10 dark:bg-neutral-800">
          <div className="flex h-9 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
            <span className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</span>
            <span className="ml-auto grid h-[18px] place-items-center rounded bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
              Planned
            </span>
          </div>
          <div className="px-3 py-3 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            Not yet implemented — editing this is read-only for now.
          </div>
        </div>
      )}
    </div>
  );
}
