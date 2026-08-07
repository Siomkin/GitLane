// Pure ref↔branch-name helpers for the create-PR form. No React, no IPC.
//
// One module because they are one concern: a pull request targets a *branch*,
// while every local read needs a *ref* git can resolve, and the two spellings
// have to be derived from the same branch list or the form opens pull requests
// against "origin/develop".

import { BranchKind, type BranchInfo } from "@/lib/api";
import type { SuggestItem } from "@/components/ui/SuggestInput";

/** Last-resort base names, only reached when git records no default branch —
 * no remote, or a clone that never wrote `refs/remotes/<remote>/HEAD`. */
const DEFAULT_BASE_GUESSES = ["main", "develop", "master"];

/** The branch a remote-tracking ref names, using its own recorded remote rather
 * than splitting on the first slash (a remote may contain one). A local branch
 * has no prefix to strip, so this is identity for those. */
export function shortName(branch: BranchInfo): string {
  const prefix = branch.remote ? `${branch.remote}/` : "";
  return prefix && branch.name.startsWith(prefix) ? branch.name.slice(prefix.length) : branch.name;
}

/**
 * Most recently updated first, matching the branch navigator's own ordering.
 *
 * Recency, not name: `list_branches` returns libgit2's alphabetical ref order,
 * which put `chore/…` above the branch cut an hour ago. The tip commit's
 * committer time is the only recency signal git offers — there is no
 * branch-modified date. A branch whose tip couldn't be read has no time to
 * compare and sinks below the dated ones, alphabetical among its peers (as are
 * two branches sharing a tip) rather than leaping to the top on a 0.
 */
function byRecency(a: BranchInfo, b: BranchInfo): number {
  const at = a.tipTime ?? null;
  const bt = b.tipTime ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at;
  }
  return a.name.localeCompare(b.name);
}

/**
 * Rows for the base picker: local branches first, then remote-tracking ones,
 * each group newest first and tagged so the two are distinguishable when a
 * branch exists under both names.
 *
 * A remote branch already offered under the same local name is dropped: they
 * name the same target to the forge, and two identical-looking rows only make
 * the list harder to search.
 */
export function baseItems(branches: BranchInfo[], head: string): SuggestItem[] {
  // `filter` already copied, so the sorts never touch the store array.
  const locals = branches
    .filter((b) => b.kind === BranchKind.Local && b.name !== head)
    .sort(byRecency)
    .map((b) => ({ value: b.name, hint: b.isHead ? "current" : undefined }));
  const localNames = new Set(locals.map((item) => item.value));
  const remotes = branches
    .filter((b) => b.kind === BranchKind.Remote && !localNames.has(shortName(b)))
    .sort(byRecency)
    .map((b) => ({ value: b.name, hint: "remote" }));
  return [...locals, ...remotes];
}

/**
 * A ref git can actually resolve for `ref`.
 *
 * The default base comes back as a forge branch name (`main`), which does not
 * resolve locally when the branch was never checked out — only `origin/main`
 * exists, and git does not fall back to it. The range and diffstat reads would
 * silently return nothing and the form would claim there is nothing to merge.
 * The forge is still told the short name; this is only for local reads.
 */
export function readableRef(branches: BranchInfo[], ref: string): string {
  if (branches.some((b) => b.name === ref)) return ref;
  return branches.find((b) => b.kind === BranchKind.Remote && shortName(b) === ref)?.name ?? ref;
}

/**
 * The branch a ref names, with any remote prefix removed.
 *
 * The prefix comes from the branch record's own `remote` field, never from
 * splitting on the first slash: a remote may itself contain a slash, and a
 * local `feature/x` has no prefix to strip at all.
 */
export function branchNameOf(branches: BranchInfo[], ref: string): string {
  const branch = branches.find((b) => b.name === ref);
  return branch ? shortName(branch) : ref;
}

/**
 * Last resort when git records no default branch: the first conventional name
 * that exists — locally, else as a remote-tracking ref — otherwise the newest
 * other branch.
 *
 * Never a name that isn't in `branches`. Inventing "main" would present a
 * confident base that does not exist, whose range read then fails and whose
 * submit fails at the forge; an empty string leaves the field visibly unset and
 * blocks submit instead.
 */
export function guessBase(branches: BranchInfo[], head: string): string {
  const usable = branches
    .filter((b) => b.name !== head && shortName(b) !== head)
    .sort(byRecency);
  const conventional = DEFAULT_BASE_GUESSES.map(
    (name) =>
      usable.find((b) => b.kind === BranchKind.Local && b.name === name) ??
      usable.find((b) => shortName(b) === name),
  ).find(Boolean);
  const local = usable.find((b) => b.kind === BranchKind.Local);
  return (conventional ?? local ?? usable[0])?.name ?? "";
}
