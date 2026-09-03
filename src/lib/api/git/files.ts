// The repository Files browser — listing, reading, and writing a path — and the
// OS hand-offs (reveal, open, difftool). Mirrors `commands/files.rs`.

import { invoke } from "@/lib/api/invoke";
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
  listRepoFiles: (path: string) => invoke<RepoFiles>("list_repo_files", { path }),

  /** Read one worktree file's text for the read-only viewer. */
  repoFileText: (path: string, file: string, maxBytes?: number) =>
    invoke<RepoFileContent>("repo_file_text", { path, file, maxBytes: maxBytes ?? null }),

  /** The committed (HEAD) text of a file — the baseline for the viewer/editor's
   * uncommitted-change gutter markers. `null` when there's nothing to diff
   * against (unborn HEAD, untracked path, binary/oversized blob). */
  repoFileHeadText: (path: string, file: string) =>
    invoke<string | null>("repo_file_head_text", { path, file }),

  /** Save an edited worktree file (in-app editor, GL-212). The size + opaque
   * state pair identifies the exact target snapshot the draft was based on;
   * Rust refuses same-size edits and atomic replacements too. Resolves with the
   * next lease for sequential saves. Overwrite-only; binary targets/content are
   * refused. */
  writeRepoFile: (path: string, file: string, content: string, expectedSize: number, expectedState: string) =>
    invoke<RepoFileWriteResult>("write_repo_file", {
      path,
      file,
      content,
      expectedSize,
      expectedState,
    }),

  /** Reveal a repo-relative path in Finder / Explorer / the system file manager. */
  revealInFileManager: (path: string, file: string) =>
    invoke<string>("reveal_in_file_manager", { path, file }),

  /** Open a repo-relative worktree leaf with the OS default application. */
  openPathDefault: (path: string, file: string) =>
    invoke<string>("open_path_default", { path, file }),

  /** Open a tracked path in the configured `git difftool` against HEAD. */
  openPathDifftool: (path: string, file: string) =>
    invoke<string>("open_path_difftool", { path, file }),
};
