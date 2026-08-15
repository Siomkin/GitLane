import type { ChangeSource } from "@/store/repoTypes";

/**
 * Shared review-note surface constructors — the single place the notes join key
 * is encoded. `StackedReview` and the changes workspace must byte-match these
 * strings (a note taken on one surface has to find the same surface elsewhere),
 * so every call site goes through a named constructor here instead of
 * re-spelling the prefix inline. The two intentional asymmetries live at the
 * call sites, not here: only the single-file review passes `workingBase`
 * (a WIP selection routes the stacked view to the compare surface instead), and
 * only `StackedReview` uses `rangeSurface` at all.
 */

/** Notes scoped to one commit (or stash commit). */
export function commitSurface(oid: string | null | undefined): string {
  return `commit:${oid ?? ""}`;
}

/** Notes scoped to a base..head range diff (`StackedReview`'s range mode). */
export function rangeSurface(base: string, head: string): string {
  return `range:${base}..${head}`;
}

/**
 * Notes scoped to a multi-commit selection. The oids are sorted so the surface
 * identity is order-independent — a refresh re-publishes the same selection
 * focus-first and additive picks differ from graph order; without the sort,
 * comments detach when the order shifts. `workingBase` is set when the
 * selection includes the WIP row — the same commits then describe a different
 * diff (a range ending at the working tree), so notes must not share a surface
 * with the committed-only union.
 */
export function selectionSurface(oids: string[], workingBase?: string | null): string {
  return `selection:${[...oids].sort().join(",")}${workingBase ? `:working:${workingBase}` : ""}`;
}

/** Notes scoped to a working file's staged/unstaged source — shared with the
 * changes workspace, so a comment shows in both panes. */
export function workSurface(source: ChangeSource): string {
  return `work:${source}`;
}

/**
 * The notes "surface" key for the single-file review pane's open file. A
 * committed file viewed as part of a **multi-commit selection** scopes to the
 * whole selection (`selection:<oids>`), matching `StackedReview`'s key for the
 * same pick — so a comment on the merged per-file diff doesn't collide with, or
 * leak into, a single-commit review of the focus commit. A single committed file
 * scopes to its commit; a working file to its staged/unstaged source.
 */
export function reviewSurface(
  selectedFile: { source: ChangeSource } | null,
  selectedCommit: string | null,
  selectionCommits: string[] | null,
  /** Set when the selection includes the WIP row — the same commits then
   * describe a different diff (a range ending at the working tree), so notes
   * must not share a surface with the committed-only union. */
  workingBase?: string | null,
): string {
  if (selectedFile?.source === "commit") {
    return selectionCommits && selectionCommits.length > 0
      ? selectionSurface(selectionCommits, workingBase)
      : commitSurface(selectedCommit);
  }
  return workSurface(selectedFile?.source ?? "unstaged");
}
