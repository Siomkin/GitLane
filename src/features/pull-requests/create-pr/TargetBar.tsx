// The target row: base-branch vs stack-on mode, and what the chosen target
// resolves to. Presentational — every value and callback comes from the form
// hook above it.

import type { BranchInfo } from "@/lib/api";
import type { PullRequest } from "@/lib/prs";
import { BasePicker } from "./BasePicker";
import { SegmentedButton } from "./SegmentedButton";

export function TargetBar({
  head,
  base,
  branches,
  onBase,
  onStacked,
  canStack,
  stacked,
  parent,
}: {
  head: string;
  base: string;
  branches: BranchInfo[];
  onBase: (name: string) => void;
  onStacked: (stacked: boolean) => void;
  /** False when the branch has no open pull request beneath it, or the forge
   * isn't GitHub — the segmented control collapses to nothing. */
  canStack: boolean;
  stacked: boolean;
  parent: PullRequest | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canStack && parent && (
        <div className="flex rounded-lg bg-black/[0.06] p-0.5 dark:bg-white/[0.08]">
          <SegmentedButton active={!stacked} onClick={() => onStacked(false)}>
            Base branch
          </SegmentedButton>
          <SegmentedButton
            active={stacked}
            onClick={() => onStacked(true)}
            title={`Target ${parent.branch}, the head branch of #${parent.num}`}
          >
            Stack on #{parent.num}
          </SegmentedButton>
        </div>
      )}

      {stacked && parent ? (
        <div className="flex items-center gap-2 font-mono text-[12.5px]">
          <span className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">
            base {parent.branch}
          </span>
          <Arrow />
          <span className="whitespace-nowrap text-[color:var(--accent)]">{head}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <BasePicker value={base} onChange={onBase} branches={branches} head={head} />
          <Arrow />
          <span className="font-mono text-[12.5px] text-[color:var(--accent)]">{head}</span>
        </div>
      )}
    </div>
  );
}


/** Points from head to base, the direction the change flows. */
function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
      className="h-4 w-4 text-neutral-400"
    >
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}
