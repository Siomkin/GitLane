// Single-file reads, history, blame, and range compare — mirrors
// `src-tauri/src/git/types/files.rs`.

import type { FileChange, FileStatus } from "./status";

/** One worktree file's text for the read-only file viewer. Binary and
 * oversized files come back as flags (`text` absent / `truncated`). */
export interface RepoFileContent {
  text?: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  /** Opaque lease for the exact repo/worktree/path, leaf identity, and raw bytes
   * represented by `text`. Omitted for truncated, binary, or lossy/non-UTF-8
   * reads, which are display-only. */
  expectedState?: string;
}

export interface RepoFileWriteResult {
  size: number;
  expectedState: string;
}

export interface FileHistoryEntry {
  oid: string;
  shortOid: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  status: FileStatus | "?";
  path: string;
  add: number;
  del: number;
  previousPath: string | null;
}

export interface FileHistoryPage {
  entries: FileHistoryEntry[];
  nextOffset: number;
  hasMore: boolean;
  truncated: boolean;
}

export interface BlameLine {
  lineNo: number;
  content: string;
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  originalPath: string;
  originalLine: number;
}

export interface FileBlame {
  path: string;
  revision: string | null;
  binary: boolean;
  truncated: boolean;
  lines: BlameLine[];
}

export interface CompareResult {
  files: FileChange[];
  add: number;
  del: number;
  ahead: number;
  behind: number;
}
