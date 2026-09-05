// Creating commits — plain and squashed — and the stash ops, which address a
// stash by commit oid because `stash@{n}` indices shift.
// Mirrors `commands/commits.rs`.

import { invoke } from "@/lib/api/invoke";
import {
  squashBranchRequestSchema,
  squashCommitsRequestSchema,
  squashRangeRequestSchema,
  stashEntrySchema,
  commitRequestSchema,
} from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

import type {
  CommitRequest,
  SquashBranchRequest,
  SquashCommitsRequest,
  SquashRangeRequest,
  StashEntry,
} from "./types";

export const commitsApi = {
  /** Create a commit. When `name`/`email` are given they are pinned as both
   * author and committer for this commit (see write.rs::commit). */
  commit: async (path: string, request: CommitRequest) => {
    parse(commitRequestSchema, request, "commit");
    return parse(z.string(), await invoke("commit", { path, request }), "commit");
  },

  /** Squash the current tip range behind one guarded backend contract. */
  squashCommits: async (path: string, request: SquashCommitsRequest) => {
    parse(squashCommitsRequestSchema, request, "squash_commits");
    return parse(
      z.string(),
      await invoke("squash_commits", { path, request }),
      "squash_commits",
    );
  },

  /** Squash a range that ends below the tip; the commits above it are replayed
   * onto the replacement commit. */
  squashRange: async (path: string, request: SquashRangeRequest) => {
    parse(squashRangeRequestSchema, request, "squash_range");
    return parse(z.string(), await invoke("squash_range", { path, request }), "squash_range");
  },

  /** Rewrite the leased local branch without checking it out. */
  squashBranch: async (path: string, request: SquashBranchRequest) => {
    parse(squashBranchRequestSchema, request, "squash_branch");
    return parse(
      z.string(),
      await invoke("squash_branch", { path, request }),
      "squash_branch",
    );
  },

  stash: async (path: string, expectedBranch: string | null, expectedOid: string | null) =>
    parse(z.string(), await invoke("stash", { path, expectedBranch, expectedOid }), "stash"),

  /** Pathspec stash for one or more literal paths (`git stash push -u -- …`). */
  stashPaths: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    files: string[],
  ) =>
    parse(
      z.string(),
      await invoke("stash_paths", { path, expectedBranch, expectedOid, files }),
      "stash_paths",
    ),

  listStashes: async (path: string): Promise<StashEntry[]> =>
    parse(z.array(stashEntrySchema), await invoke("list_stashes", { path }), "list_stashes"),

  // Stash ops address the stash by commit oid — `stash@{n}` indices shift
  // whenever any stash is created/dropped (globally, across worktrees), so an
  // index captured at list time can hit the wrong stash (GL-117).
  stashApply: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    oid: string,
  ) =>
    parse(
      z.string(),
      await invoke("stash_apply", { path, expectedBranch, expectedOid, oid }),
      "stash_apply",
    ),

  /** Apply a stash restoring the staged (index) state too (`git stash apply --index`). */
  stashApplyIndex: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    oid: string,
  ) =>
    parse(
      z.string(),
      await invoke("stash_apply_index", { path, expectedBranch, expectedOid, oid }),
      "stash_apply_index",
    ),

  /** Check out `branch` at the stash's parent and apply the stash there. */
  stashBranch: async (path: string, branch: string, oid: string) =>
    parse(z.string(), await invoke("stash_branch", { path, branch, oid }), "stash_branch"),

  stashPop: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    oid: string,
  ) =>
    parse(
      z.string(),
      await invoke("stash_pop", { path, expectedBranch, expectedOid, oid }),
      "stash_pop",
    ),

  stashDrop: async (path: string, oid: string) =>
    parse(z.string(), await invoke("stash_drop", { path, oid }), "stash_drop"),
};
