// Unified diffs + binary blobs — mirrors `src-tauri/src/git/types/diff.rs`.

import type { FileStatus } from "./status";

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  add: number;
  del: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** True when the backend capped the diff at the line limit; the UI offers a
   * "show full diff" that re-fetches with `full: true`. */
  truncated: boolean;
  /** Byte size of the old / new side of a **binary** change, so the UI can show
   * "old → new (±delta)" instead of "+0 −0". Absent when that side doesn't exist
   * (added has no old, deleted no new) or for text diffs. */
  oldSize?: number;
  newSize?: number;
  /** Blob oids for each side of the change, passed to
   * {@link gitApi.readBinaryBlob} to fetch content for a preview (image bytes,
   * markdown source). Absent when the side doesn't exist or libgit2 left no
   * oid. The working-tree side of an unstaged diff is unreliable by oid (zero
   * for binary; a computed hash that need not exist in the ODB for text) —
   * read that side from disk by `path` instead. */
  oldOid?: string;
  newOid?: string;
  /** Owning commit when the diff came from a per-commit patch (`gh pr diff`
   * emits one message per commit): full oid + subject line. Absent for
   * libgit2/status diffs. The PR Diff tab groups same-commit files under one
   * header. */
  commitOid?: string;
  commitSubject?: string;
}

/** Raw bytes of one blob / working-tree file for an inline preview (see Rust
 * `BinaryBlob`). `base64` is absent when the content exceeded the preview cap
 * (then `truncated` is true and only `size` is meaningful). */
export interface BinaryBlob {
  base64?: string;
  size: number;
  truncated: boolean;
}
