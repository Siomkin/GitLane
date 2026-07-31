// The PR-list stack badge: layers mark + `position/size`, matching GitHub's own
// row badge. Its data comes from the repo-wide stack read that rides the list
// load, so every row can carry it — not from the per-PR detail read.

import type { PrStackMembership } from "@/lib/api";

export function StackBadge({ membership }: { membership: PrStackMembership }) {
  const { position, size, stackNumber } = membership;
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-neutral-400"
      // Stack numbers share the issue/PR sequence, so the title says "stack"
      // explicitly rather than rendering a bare `#310` that reads as a PR.
      title={`Layer ${position} of ${size} in stack ${stackNumber}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-3 w-3">
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 13 9 5 9-5" />
      </svg>
      <span className="tabular-nums">
        {position}/{size}
      </span>
    </span>
  );
}
