// Creating commits — plain and squashed — and the stash ops, which address a
// stash by commit oid because `stash@{n}` indices shift.
// Mirrors `commands/commits.rs`.

import { invoke } from "@/lib/api/invoke";
import { stashEntrySchema } from "@/lib/api/schemas";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

import { capturedIdentityArg } from "./capturedIdentity";
import type {
  RepoIdentity,
  StashEntry,
} from "./types";

export const commitsApi = {
  /** Create a commit. When `authorName`/`authorEmail` are given they are pinned
   * as both author and committer for this commit (see write.rs::commit). */
  commit: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    summary: string,
    description: string,
    amend: boolean,
    authorName?: string | null,
    authorEmail?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    parse(
      z.string(),
      await invoke("commit", {
        path,
        expectedBranch,
        expectedOid,
        summary,
        description,
        amend,
        name: authorName ?? null,
        email: authorEmail ?? null,
        identity: capturedIdentityArg(identity),
      }),
      "commit",
    ),

  /** Squash the current tip range behind one guarded backend contract. */
  squashCommits: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    parentOid: string,
    summary: string,
    description: string,
    authorName?: string | null,
    authorEmail?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    parse(
      z.string(),
      await invoke("squash_commits", {
        path,
        expectedBranch,
        expectedOid,
        parentOid,
        summary,
        description,
        name: authorName ?? null,
        email: authorEmail ?? null,
        identity: capturedIdentityArg(identity),
      }),
      "squash_commits",
    ),

  /** Squash a range that ends below the tip; the commits above it are replayed
   * onto the replacement commit. */
  squashRange: async (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    newestOid: string,
    parentOid: string,
    summary: string,
    description: string,
    authorName?: string | null,
    authorEmail?: string | null,
    identity?: RepoIdentity | null,
  ) =>
    parse(
      z.string(),
      await invoke("squash_range", {
        path,
        expectedBranch,
        expectedOid,
        newestOid,
        parentOid,
        summary,
        description,
        name: authorName ?? null,
        email: authorEmail ?? null,
        identity: capturedIdentityArg(identity),
      }),
      "squash_range",
    ),

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
