// Opening a repository and reading its shape: the commit graph, history
// search, branch list, and ancestry queries — plus the filesystem watcher and
// the onboarding path (clone / init / recents). Mirrors `commands/repo.rs`.

import { invoke } from "@/lib/api/invoke";
import { parse } from "@/lib/api/validate";
import { historySearchPageSchema, historySearchResultSchema, repoGraphSchema } from "@/lib/api/schemas";
import { z } from "zod";
import type {
  BranchInfo,
  GitTransportAuthRef,
  HistorySearchPage,
  HistorySearchQuery,
  HistorySearchResult,
  RecentStatus,
  RepoGraph,
  RepoSummary,
} from "./types";

export const repoApi = {
  openRepo: (path: string) => invoke<RepoSummary>("open_repo", { path }),

  commitGraph: async (path: string, limit?: number): Promise<RepoGraph> =>
    parse(repoGraphSchema, await invoke("commit_graph", { path, limit: limit ?? null }), "commit_graph"),

  searchHistory: async (path: string, query: HistorySearchQuery): Promise<HistorySearchPage> =>
    parse(historySearchPageSchema, await invoke("search_history", { path, query }), "search_history"),

  /** HEAD-tree paths (files + directories) containing `filter`, for the
   * advanced search's File-path autosuggest. */
  suggestTreePaths: (path: string, filter: string, limit?: number) =>
    invoke<string[]>("suggest_tree_paths", { path, filter, limit: limit ?? null }),

  listBranches: (path: string) =>
    invoke<BranchInfo[]>("list_branches", { path }),

  /** True when `to` can be fast-forwarded to `from` (from is a descendant of to). */
  canFastForward: (path: string, from: string, to: string) =>
    invoke<boolean>("can_fast_forward", { path, from, to }),

  /** The commits `base..head` would carry, newest first. Graph-only — pair it
   * with [`compareRefs`] for the file/line totals. */
  rangeCommits: async (path: string, base: string, head: string): Promise<HistorySearchResult[]> =>
    parse(
      z.array(historySearchResultSchema),
      await invoke("range_commits", { path, base, head }),
      "range_commits",
    ),

  /** Which of `candidates` `head` descends from, nearest first. Candidates that
   * don't resolve are skipped rather than failing the call. */
  ancestorRefs: async (path: string, head: string, candidates: string[]): Promise<string[]> =>
    parse(
      z.array(z.string()),
      await invoke("ancestor_refs", { path, head, candidates }),
      "ancestor_refs",
    ),

  /** The branch a new pull request from `head` should target by default:
   * gh's `branch.<head>.gh-merge-base` override, else the remote's default
   * branch from `refs/remotes/<remote>/HEAD`. Null when neither is known. */
  defaultBaseBranch: (path: string, head: string) =>
    invoke<string | null>("default_base_branch", { path, head }),

  /** Clone `url` into `dest`, streaming `clone-progress` events while it runs.
   * Resolves with the cloned repo's path; the caller then opens it. Reject with
   * the git failure text (classified UI-side into exists/auth/unreachable). */
  cloneRepo: (url: string, dest: string, auth?: GitTransportAuthRef | null) =>
    invoke<string>("clone_repo", { url, dest, auth: auth ?? null }),

  /** Cancel an in-flight {@link cloneRepo}. Rejects once publication has won
   * the atomic backend race, so callers must keep the success path active. */
  cancelClone: () => invoke<void>("cancel_clone"),

  /** Initialize a new repo at `parent`/`name` on `branch`, optionally seeding a
   * README and a `.gitignore` template. Resolves with the new repo's path. */
  initRepo: (
    parent: string,
    name: string,
    branch: string,
    readme: boolean,
    gitignore: string,
  ) => invoke<string>("init_repo", { parent, name, branch, readme, gitignore }),

  /** Initialize an already-existing, possibly non-empty directory as a repo
   * in place (the missing-repo screen's "Initialize as git repo" recovery
   * action, GL-153) — no README/.gitignore scaffolding. Resolves with the
   * canonical repo path from the post-init open probe. */
  initRepoInPlace: (path: string) => invoke<string>("init_repo_in_place", { path }),

  /** Presence + current branch for each recent repo path (missing-path + branch
   * info for the onboarding "Recent" list). */
  recentsStatus: (paths: string[]) => invoke<RecentStatus[]>("recents_status", { paths }),

  /** Reveal `path` in the OS file manager (Finder/Explorer). */
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),

  /** Start watching `path` (one watch per open tab); the backend emits
   * `repo-changed` events tagged with this path on any change. Linked
   * worktrees also cover their private gitdir and shared common dir. */
  watchRepo: (path: string) => invoke<void>("watch_repo", { path }),

  /** Stop watching `path` (its tab closed). Unknown paths are a no-op. */
  unwatchRepo: (path: string) => invoke<void>("unwatch_repo", { path }),
};
