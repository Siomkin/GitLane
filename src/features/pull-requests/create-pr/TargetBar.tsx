// The target row: base-branch vs stack-on mode, and what the chosen target
// resolves to. Presentational — every value and callback comes from the form
// hook above it.

import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/cn";
import type { PullRequest } from "@/lib/prs";
import { PR_TARGET_MODE, type PrTargetMode } from "./prTargets";

export function TargetBar({
  head,
  base,
  branchNames,
  onBase,
  onMode,
  canStack,
  stacked,
  parent,
}: {
  head: string;
  base: string;
  branchNames: string[];
  onBase: (name: string) => void;
  onMode: (mode: PrTargetMode) => void;
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
          <SegmentButton
            active={!stacked}
            onClick={() => onMode(PR_TARGET_MODE.Base)}
            label="Base branch"
          />
          <SegmentButton
            active={stacked}
            onClick={() => onMode(PR_TARGET_MODE.Stack)}
            label={`Stack on #${parent.num}`}
            title={`Target ${parent.branch}, the head branch of #${parent.num}`}
          />
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
          <Select
            aria-label="Base branch"
            value={base}
            onChange={(e) => onBase(e.target.value)}
            className="h-8 rounded-lg border border-black/10 bg-transparent py-0 pl-2.5 font-mono text-[12.5px] text-neutral-700 focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-200"
          >
            {!branchNames.includes(base) && <option value={base}>{base}</option>}
            {branchNames.map((name) => (
              <option key={name} value={name} className="dark:bg-neutral-800">
                {name}
              </option>
            ))}
          </Select>
          <Arrow />
          <span className="font-mono text-[12.5px] text-[color:var(--accent)]">{head}</span>
        </div>
      )}
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "h-8 whitespace-nowrap rounded-md px-3 text-[12.5px] font-medium transition-colors",
        active
          ? "bg-white text-neutral-800 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
      )}
    >
      {label}
    </button>
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
