/** Pure pin-ordering for navigator lists (no React, no stores).
 *
 * Rows sort by rank — current ref first, then pinned rows, then the rest —
 * keeping the incoming (alphabetical) order within each rank. When a pinned run
 * is followed by unpinned rows, `separatorAt` is the index of the first
 * unpinned row so the list can draw a hairline between the two runs (the
 * design's pinned/unpinned divider). It is null when nothing is pinned or when
 * every row is pinned/current.
 */

export interface PinnableRow {
  pinned: boolean;
  current?: boolean;
}

const rank = (row: PinnableRow) => (row.current ? 2 : row.pinned ? 1 : 0);

export function orderWithPins<T extends PinnableRow>(rows: T[]): { rows: T[]; separatorAt: number | null } {
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(b.row) - rank(a.row) || a.index - b.index)
    .map((entry) => entry.row);
  if (!ordered.some((row) => row.pinned && !row.current)) return { rows: ordered, separatorAt: null };
  const firstUnpinned = ordered.findIndex((row) => rank(row) === 0);
  return { rows: ordered, separatorAt: firstUnpinned > 0 ? firstUnpinned : null };
}
