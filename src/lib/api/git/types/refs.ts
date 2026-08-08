// Branches, reflog, and stashes — mirrors `src-tauri/src/git/types/refs.rs`.

/** Kind of a branch entry / drag ref (a *local* or *remote-tracking* branch),
 * distinct from `RefKind` (which also covers tags/HEAD). Same const-object rule:
 * compare against `BranchKind.Local`, not `"local"`. */
export const BranchKind = {
  Local: "local",
  Remote: "remote",
} as const;
export type BranchKind = (typeof BranchKind)[keyof typeof BranchKind];

export interface BranchInfo {
  name: string;
  kind: BranchKind;
  target: string | null;
  /** Committer time (epoch seconds) of the branch tip. Git stores no branch
   * creation time, so this stands in for "last updated" — what the navigator
   * orders branches and remotes by. `null` when the tip can't be resolved.
   * Optional here to match its siblings (`upstreamRemote`, `sync`), which are
   * also always-serialized Rust `Option`s — fixtures stay terse, and consumers
   * treat a missing value the same as `null`. */
  tipTime?: number | null;
  isHead: boolean;
  upstream: string | null;
  /** For a remote branch, the remote it belongs to (resolved by the backend
   * against the known remote list). `null` for local branches. */
  remote: string | null;
  /** For a local branch, its configured fetch/upstream remote
   * (`branch.<name>.remote`); `.` means another branch in this repository.
   * `null` for remote branches or when unset. */
  upstreamRemote?: string | null;
  /** For a local branch, the actual push remote after Git's
   * branch.pushRemote → remote.pushDefault → branch.remote → origin
   * precedence. `null` for remote branches. */
  pushRemote?: string | null;
  sync?: BranchSyncState | null;
}

export type BranchSyncStatus =
  | "noRemote"
  | "noUpstream"
  | "staleUpstream"
  | "unknown"
  | "upToDate"
  | "ahead"
  | "behind"
  | "diverged";

export interface BranchSyncState {
  status: BranchSyncStatus;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface ReflogEntry {
  oid: string;
  shortOid: string;
  selector: string;
  shortSelector: string;
  refName: string;
  subject: string;
  committerName: string;
  committerEmail: string;
  timestamp: number;
}

export interface StashEntry {
  index: number;
  message: string;
  oid: string;
  /** Committer time of the stash commit itself — used to slot the stash into the
   * date-ordered history where it was created (date-ordered placement). */
  timestamp: number;
  baseOid: string | null;
  baseTimestamp: number | null;
  context: StashContextCommit[];
}

export interface StashContextCommit {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  parents: string[];
}
