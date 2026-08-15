// Commit-graph layout + history search — mirrors `src-tauri/src/git/types/graph.rs`.

/** Kind of ref a graph label carries, emitted by the backend. Compare against
 * `RefKind.Tag` rather than a bare `"tag"` literal so a typo fails to compile.
 * Keep in sync with the Rust side across the IPC boundary. */
export const RefKind = {
  Branch: "branch",
  Remote: "remote",
  Tag: "tag",
  Head: "head",
} as const;
export type RefKind = (typeof RefKind)[keyof typeof RefKind];

export interface RefLabel {
  name: string;
  kind: RefKind;
  /** Exact object named by a tag ref. Unlike the containing commit id, this is
   * the annotated-tag object oid and is used as the deletion CAS token. */
  targetOid?: string | null;
}

/** Marks a graph node that is an in-window stash rather than a commit (see the
 * Rust `StashRef`). The node's single parent is the stash base; the frontend
 * paints it as the amber `stash@{index}` marker with a dashed edge to the base. */
export interface StashRef {
  index: number;
  message: string;
}

export interface CommitNode {
  id: string;
  shortId: string;
  summary: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number; // unix seconds
  parents: string[];
  lane: number;
  row: number;
  refs: RefLabel[];
  /** Present (and non-null) only when this node is an injected in-window stash. */
  stash?: StashRef | null;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  /** Zero-based parent index on the child commit; > 0 means merge parent.
   * Always present — the Rust `GraphEdge` sends it on every edge. */
  parentIndex: number;
  color: number;
}

export interface RepoGraph {
  commits: CommitNode[];
  edges: GraphEdge[];
  laneCount: number;
  /** Synthetic WIP marker lane, when the backend resolves one separately from HEAD. */
  wipLane?: number | null;
  head: string | null;
  truncated: boolean;
}

export interface HistorySearchQuery {
  messagePattern?: string;
  author?: string;
  path?: string;
  revision?: string;
  changedPattern?: string;
  occurrenceText?: string;
  /** Inclusive committer-date bounds, epoch seconds (git log --since/--until). */
  sinceTimestamp?: number;
  untilTimestamp?: number;
  limit?: number;
}

export interface HistorySearchResult {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

export interface HistorySearchPage {
  results: HistorySearchResult[];
  truncated: boolean;
  workTruncated: boolean;
}
