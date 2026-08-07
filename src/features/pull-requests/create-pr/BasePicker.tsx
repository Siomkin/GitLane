// The base-branch field: a filterable branch list rather than a native select,
// because a repository with dozens of branches makes an OS dropdown unusable —
// GitHub's own base dropdown has a filter field for the same reason.

import { BranchKind, type BranchInfo } from "@/lib/api";
import { SuggestInput, type SuggestItem } from "@/components/ui/SuggestInput";

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
    <SuggestInput
      value={value}
      onChange={onChange}
      onPick={onChange}
      items={shown}
      ariaLabel="Base branch"
      placeholder="Base branch"
      className="h-8 w-[260px] rounded-lg border border-black/10 bg-transparent px-2.5 font-mono text-[12.5px] text-neutral-700 outline-none focus:border-[color:var(--accent)] dark:border-white/10 dark:text-neutral-200"
    />
  );
}

/**
 * Local branches first, then remote-tracking ones, each tagged so the two are
 * distinguishable when a branch exists under both names.
 *
 * A remote branch already offered under the same local name is dropped: they
 * name the same target to the forge, and two identical-looking rows only make
 * the list harder to search.
 */
function baseItems(branches: BranchInfo[], head: string): SuggestItem[] {
  const locals = branches
    .filter((b) => b.kind === BranchKind.Local && b.name !== head)
    .map((b) => ({ value: b.name, hint: b.isHead ? "current" : undefined }));
  const localNames = new Set(locals.map((item) => item.value));
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote && !localNames.has(shortName(b)))
    .map((b) => ({ value: b.name, hint: "remote" }));
  return [...locals, ...remotes];
}

/** The branch a remote-tracking ref names, using its own recorded remote
 * rather than splitting on the first slash (a remote may contain one). */
function shortName(branch: BranchInfo): string {
  const prefix = branch.remote ? `${branch.remote}/` : "";
  return prefix && branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}
