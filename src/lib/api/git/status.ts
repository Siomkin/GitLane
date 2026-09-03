// Working-tree status and every diff read — file, commit, range, selection, and
// comparison — plus blame and file history. Mirrors `commands/status.rs`.

import { invoke } from "@/lib/api/invoke";
import { parse } from "@/lib/api/validate";
import { fileDiffSchema, workingChangesSchema } from "@/lib/api/schemas";
import type {
  BinaryBlob,
  CompareResult,
  FileBlame,
  FileChange,
  FileDiff,
  FileHistoryPage,
  WorkingChanges,
} from "./types";

export const statusApi = {
  workingChanges: async (path: string): Promise<WorkingChanges> =>
    // The schema defaults `conflicted` to [] (the long-standing defensive
    // contract, so every consumer can rely on the field) and rejects any other
    // shape drift with a clear IpcValidationError.
    parse(workingChangesSchema, await invoke("working_changes", { path }), "working_changes"),

  /** Diff for a working-tree file. `staged` true → index vs HEAD; false → worktree vs index.
   * `full` bypasses the backend line cap (for an explicit "show full diff"). */
  fileDiff: async (path: string, file: string, staged: boolean, full?: boolean): Promise<FileDiff> =>
    parse(fileDiffSchema, await invoke("file_diff", { path, file, staged, full: full ?? null }), "file_diff"),

  /** Changed files in a commit (vs its first parent). */
  commitFiles: (path: string, oid: string) =>
    invoke<FileChange[]>("commit_files", { path, oid }),

  /** Read a binary blob's bytes (base64) for an inline preview. Pass `oid` for a
   * committed/staged blob; pass `file` (repo-relative, `oid` omitted) to read the
   * working-tree copy — the side an unstaged diff leaves without a blob oid. */
  readBinaryBlob: (
    path: string,
    source: { oid?: string | null; file?: string | null },
    maxBytes?: number,
  ) =>
    invoke<BinaryBlob>("read_binary_blob", {
      path,
      oid: source.oid ?? null,
      file: source.file ?? null,
      maxBytes: maxBytes ?? null,
    }),

  /** Diff for one file within a commit (vs its first parent). `full` bypasses
   * the backend line cap (for an explicit "show full diff"). */
  commitFileDiff: async (path: string, oid: string, file: string, full?: boolean): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("commit_file_diff", { path, oid, file, full: full ?? null }),
      "commit_file_diff",
    ),

  /** Changed files across a range base..head (either side accepts any
   * commit-ish: a SHA, "HEAD", a branch). */
  diffRange: (path: string, base: string, head: string) =>
    invoke<FileChange[]>("diff_range", { path, base, head }),

  /** Diff for one file across a range base..head. `full` bypasses the backend
   * line cap (for an explicit "show full diff"). */
  diffRangeFile: async (
    path: string,
    base: string,
    head: string,
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("diff_range_file", { path, base, head, file, full: full ?? null }),
      "diff_range_file",
    ),

  /** Merged ("union") changed files across a multi-commit selection (GL-69): the
   * net change per file across `oids` (in any order), with status + counts. For
   * each file the net is computed from its state before the earliest selected
   * commit that touches it to its state after the latest one. */
  selectionDiff: (path: string, oids: string[]) =>
    invoke<FileChange[]>("selection_diff", { path, oids }),

  /** Merged diff for one file across a multi-commit selection (see
   * {@link selectionDiff}). `full` bypasses the backend line cap. */
  selectionDiffFile: async (
    path: string,
    oids: string[],
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("selection_diff_file", { path, oids, file, full: full ?? null }),
      "selection_diff_file",
    ),

  /** Bounded newest-first history for a repository-relative file path. */
  fileHistory: (path: string, file: string, offset?: number, limit?: number) =>
    invoke<FileHistoryPage>("file_history", {
      path,
      file,
      offset: offset ?? null,
      limit: limit ?? null,
    }),

  /** Line-level attribution for a text file at a revision or the working tree. */
  fileBlame: (path: string, file: string, revision?: string | null, limit?: number) =>
    invoke<FileBlame>("file_blame", {
      path,
      file,
      revision: revision ?? null,
      limit: limit ?? null,
    }),

  /** Changed files plus totals for a `base..head` comparison. `head = null`
   * compares `base` against the working tree. */
  compareRefs: (path: string, base: string, head?: string | null) =>
    invoke<CompareResult>("compare_refs", { path, base, head: head ?? null }),

  /** Full diff for one file within a comparison (see [`compareRefs`]). */
  compareFileDiff: async (
    path: string,
    base: string,
    head: string | null,
    file: string,
    full?: boolean,
  ): Promise<FileDiff> =>
    parse(
      fileDiffSchema,
      await invoke("compare_file_diff", { path, base, head: head ?? null, file, full: full ?? null }),
      "compare_file_diff",
    ),
};
