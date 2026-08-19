// The tab order as the strip draws it, for the non-visual consumers.
//
// Repo groups make the drawn order differ from the stored `openPaths` (a
// group's later members are pulled forward behind its chip). Anything that
// means "the tab to the left/right" or "the Nth tab" — ⌘1…9, ⌘⇧[/], the
// neighbour a close lands on — must agree with what the user sees, so it goes
// through here instead of indexing `openPaths`.

import { drawnTabOrder, tabIdentity, type TabInfo } from "@/lib/tabs";
import {
  repoGroupCollapsed,
  repoGroupOf,
  useUi,
  type RepoCollapseState,
  type RepoLabelsState,
} from "@/store/ui";

/** The group state the order depends on. Taken as a parameter rather than read
 * inside, so the ordering is a pure function of its inputs and can be unit
 * tested without standing up the ui store; `currentLabels()` is the one place
 * that reaches for it. */
export type TabOrderLabels = RepoLabelsState & RepoCollapseState;

export const currentLabels = (): TabOrderLabels => useUi.getState();

export function visualTabOrder(
  openPaths: string[],
  tabInfoByPath: Record<string, TabInfo>,
  /** The tab the strip highlights. A collapsed group still draws it, so it
   * stays in the order; the group's other tabs are folded away and do not. */
  activePath: string | null = null,
  labels: TabOrderLabels = currentLabels(),
): string[] {
  return drawnTabOrder(
    openPaths,
    (path) => repoGroupOf(labels, tabIdentity(path, tabInfoByPath[path]))?.id ?? null,
    { collapsed: (groupId) => repoGroupCollapsed(labels, groupId), activePath },
  );
}

/** The tab a close lands on: the drawn neighbour to the left, else the first
 * remaining tab. Returns null when nothing is left open. */
export function neighbourTabPath(
  openPaths: string[],
  tabInfoByPath: Record<string, TabInfo>,
  closing: string,
  labels: TabOrderLabels = currentLabels(),
): string | null {
  // The closing tab is the one being drawn, so it is the active path as far as
  // the order is concerned — that keeps it in the order for the `indexOf`
  // below even when it sits inside a collapsed group.
  const order = visualTabOrder(openPaths, tabInfoByPath, closing, labels);
  const index = order.indexOf(closing);
  const remaining = order.filter((path) => path !== closing);
  return remaining[Math.max(0, index - 1)] ?? remaining[0] ?? null;
}
