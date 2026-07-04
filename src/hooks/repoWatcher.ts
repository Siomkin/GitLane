export type RepoChangeKind = "worktree" | "graph";
export type RefreshScope = "worktree" | "all";

export interface RepoChangedEvent {
  kind: RepoChangeKind;
  /** The open path whose watch fired (`summary.path`) — with one watcher per
   * open tab, events must be routed to the tab they belong to. */
  path: string;
}

/**
 * Normalize an open path for event routing. The watch key, `summary.path`, and
 * the `openPaths` entries all derive from the same `open_repo` result today, so
 * exact equality already matches — but routing on a raw string is fragile: a
 * path that reaches routing in a slightly different representation (a trailing
 * separator, most plausibly) would silently drop *every* event for that tab,
 * with only the active tab's focus/visibility resync as a safety net (GL-125).
 * Trimming a trailing separator lets those representations still route to the
 * right tab. (Deeper canonicalization — `/tmp` vs `/private/tmp` realpath — is
 * orthogonal and predates GL-116; kept out of scope here.)
 */
export function normalizeWatchPath(path: string): string {
  // Preserve a lone "/" (filesystem root); only trim a trailing separator
  // otherwise.
  return path.length > 1 && (path.endsWith("/") || path.endsWith("\\"))
    ? path.slice(0, -1)
    : path;
}

/** Graph work dominates worktree-only refreshes inside one debounce window. */
export function mergeRefreshScope(
  current: RefreshScope | null,
  kind: RepoChangeKind,
): RefreshScope {
  if (current === "all" || kind === "graph") return "all";
  return "worktree";
}
