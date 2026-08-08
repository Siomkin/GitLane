// Creating commits — plain and squashed — and the stash ops, which address a
// stash by commit oid because `stash@{n}` indices shift.
// Mirrors `commands/commits.rs`.

import { invoke } from "@tauri-apps/api/core";
import type {
  RepoIdentity,
  StashEntry,
} from "./types";

export const commitsApi = {
  /** Create a commit. When `authorName`/`authorEmail` are given they are pinned
   * as both author and committer for this commit (see write.rs::commit). */
  commit: (
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
    invoke<string>("commit", {
      path,
      expectedBranch,
      expectedOid,
      summary,
      description,
      amend,
      name: authorName ?? null,
      email: authorEmail ?? null,
      identity: identity ?? null,
      identityCaptured: identity !== undefined,
    }),

  /** Squash the current tip range behind one guarded backend contract. */
  squashCommits: (
    path: string,
    expectedBranch: string | null,
    expectedOid: string,
    parentOid: string,
    summary: string,
    description: string,
    authorName?: string | null,
    authorEmail?: string | null,
    identity?: RepoIdentity | null,
  ) => invoke<string>("squash_commits", {
    path,
    expectedBranch,
    expectedOid,
    parentOid,
    summary,
    description,
    name: authorName ?? null,
    email: authorEmail ?? null,
    identity: identity ?? null,
    identityCaptured: identity !== undefined,
  }),

  stash: (path: string, expectedBranch: string | null, expectedOid: string | null) =>
    invoke<string>("stash", { path, expectedBranch, expectedOid }),

  /** Pathspec stash for one or more literal paths (`git stash push -u -- …`). */
  stashPaths: (
    path: string,
    expectedBranch: string | null,
    expectedOid: string | null,
    files: string[],
  ) => invoke<string>("stash_paths", { path, expectedBranch, expectedOid, files }),

  listStashes: (path: string) => invoke<StashEntry[]>("list_stashes", { path }),

  // Stash ops address the stash by commit oid — `stash@{n}` indices shift
  // whenever any stash is created/dropped (globally, across worktrees), so an
  // index captured at list time can hit the wrong stash (GL-117).
  stashApply: (path: string, expectedBranch: string | null, expectedOid: string | null, oid: string) =>
    invoke<string>("stash_apply", { path, expectedBranch, expectedOid, oid }),

  /** Apply a stash restoring the staged (index) state too (`git stash apply --index`). */
  stashApplyIndex: (path: string, expectedBranch: string | null, expectedOid: string | null, oid: string) =>
    invoke<string>("stash_apply_index", { path, expectedBranch, expectedOid, oid }),

  /** Check out `branch` at the stash's parent and apply the stash there. */
  stashBranch: (path: string, branch: string, oid: string) => invoke<string>("stash_branch", { path, branch, oid }),

  stashPop: (path: string, expectedBranch: string | null, expectedOid: string | null, oid: string) =>
    invoke<string>("stash_pop", { path, expectedBranch, expectedOid, oid }),

  stashDrop: (path: string, oid: string) => invoke<string>("stash_drop", { path, oid }),
};
