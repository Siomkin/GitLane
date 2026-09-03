// The repository Files browser — listing, reading, and writing a path — and the
// OS hand-offs (reveal, open, difftool). Mirrors `commands/files.rs`.

import { invoke } from "@/lib/api/invoke";
import {
  repoFileContentSchema,
  repoFileWriteResultSchema,
  repoFilesSchema,
} from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";
import type {
  RepoFileContent,
  RepoFileWriteResult,
  RepoFiles,
} from "./types";

export const filesApi = {
  /** Every file in the worktree (tracked + untracked, ignored excluded),
   * repo-relative and sorted — bounded to the backend's listing cap, with
   * `truncated` set when the repository holds more. Whole-repo path search
   * stays with `suggestTreePaths`, which is not limited to this prefix. */
  listRepoFiles: async (path: string): Promise<RepoFiles> =>
    parse(repoFilesSchema, await invoke("list_repo_files", { path }), "list_repo_files"),

  /** Read one worktree file's text for the read-only viewer. */
  repoFileText: async (path: string, file: string, maxBytes?: number): Promise<RepoFileContent> =>
    parse(
      repoFileContentSchema,
      await invoke("repo_file_text", { path, file, maxBytes: maxBytes ?? null }),
      "repo_file_text",
    ),

  /** The committed (HEAD) text of a file — the baseline for the viewer/editor's
   * uncommitted-change gutter markers. `null` when there's nothing to diff
   * against (unborn HEAD, untracked path, binary/oversized blob). */
  repoFileHeadText: async (path: string, file: string) =>
    parse(
      z.string().nullable(),
      await invoke("repo_file_head_text", { path, file }),
      "repo_file_head_text",
    ),

  /** Save an edited worktree file (in-app editor, GL-212). The size + opaque
   * state pair identifies the exact target snapshot the draft was based on;
   * Rust refuses same-size edits and atomic replacements too. Resolves with the
   * next lease for sequential saves. Overwrite-only; binary targets/content are
   * refused. */
  writeRepoFile: async (
    path: string,
    file: string,
    content: string,
    expectedSize: number,
    expectedState: string,
  ): Promise<RepoFileWriteResult> =>
    parse(
      repoFileWriteResultSchema,
      await invoke("write_repo_file", { path, file, content, expectedSize, expectedState }),
      "write_repo_file",
    ),

  /** Reveal a repo-relative path in Finder / Explorer / the system file manager. */
  revealInFileManager: async (path: string, file: string) =>
    parse(
      z.string(),
      await invoke("reveal_in_file_manager", { path, file }),
      "reveal_in_file_manager",
    ),

  /** Open a repo-relative worktree leaf with the OS default application. */
  openPathDefault: async (path: string, file: string) =>
    parse(z.string(), await invoke("open_path_default", { path, file }), "open_path_default"),

  /** Open a tracked path in the configured `git difftool` against HEAD. */
  openPathDifftool: async (path: string, file: string) =>
    parse(z.string(), await invoke("open_path_difftool", { path, file }), "open_path_difftool"),
};
