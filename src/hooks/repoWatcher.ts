export type RepoChangeKind = "worktree" | "graph";
export type RefreshScope = "worktree" | "all";

export interface RepoChangedEvent {
  kind: RepoChangeKind;
  /** The open path whose watch fired (`summary.path`) — with one watcher per
   * open tab, events must be routed to the tab they belong to. */
  path: string;
}

/** Graph work dominates worktree-only refreshes inside one debounce window. */
export function mergeRefreshScope(
  current: RefreshScope | null,
  kind: RepoChangeKind,
): RefreshScope {
  if (current === "all" || kind === "graph") return "all";
  return "worktree";
}
