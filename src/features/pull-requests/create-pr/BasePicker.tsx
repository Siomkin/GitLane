// The base-branch field: a filterable branch list rather than a native select,
// because a repository with dozens of branches makes an OS dropdown unusable —
// GitHub's own base dropdown has a filter field for the same reason.

import { type BranchInfo } from "@/lib/api";
import { ChevronDownIcon } from "@/components/ui/icons";
import { SuggestInput } from "@/components/ui/SuggestInput";
import { baseItems } from "./branchRefs";

export function BasePicker({
  value,
  onChange,
  branches,
  head,
}: {
  value: string;
  onChange: (value: string) => void;
  branches: BranchInfo[];
  /** Excluded from the list — a pull request cannot target its own branch. */
  head: string;
}) {
  const items = baseItems(branches, head);
  // Typing filters; a value that exactly names a branch does not, so clicking
  // into a settled field shows the whole list instead of the one row matching
  // what is already chosen.
  const query = value.trim().toLowerCase();
  const settled = items.some((item) => item.value === value);
  const shown =
    !query || settled ? items : items.filter((item) => item.value.toLowerCase().includes(query));

  return (
    // The chevron is decorative but load-bearing: without it the field reads as
    // a text box, and nothing suggests there is a list behind it.
    <div className="relative w-[260px]">
      <SuggestInput
        value={value}
        onChange={onChange}
        onPick={onChange}
        items={shown}
        ariaLabel="Base branch"
        placeholder="Base branch"
        className="h-8 w-full rounded-lg border border-black/10 bg-transparent pl-2.5 pr-7 font-mono text-[12.5px] text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-200"
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-2 h-4 w-4 text-neutral-400"
      />
    </div>
  );
}

