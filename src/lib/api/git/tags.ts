// Local tag writes, and the patch files generated from a commit, a range, or the
// working tree. Remote tag pushes and deletes live in `remotes`.
// Mirrors `commands/tags.rs`.

import { invoke } from "@/lib/api/invoke";

export const tagsApi = {
  /** Create a lightweight tag at the captured `sha`. */
  createTag: (path: string, name: string, sha: string) =>
    invoke<string>("create_tag", { path, name, sha }),

  /** Create an annotated tag (tagger + `message`) at the captured `sha`. */
  createAnnotatedTag: (path: string, name: string, message: string, sha: string) =>
    invoke<string>("create_annotated_tag", { path, name, message, sha }),

  /** Write a `.patch` file for the single commit `sha` into the worktree
   * (`git format-patch -1`); resolves with the created filename. */
  createPatch: (path: string, sha: string) =>
    invoke<string>("create_patch", { path, sha }),

  /** Write one mailbox `.patch` file covering the contiguous `base..head`
   * range (`git format-patch`); resolves with the created filename. Callers
   * gate this on a first-parent-contiguous selection. */
  createPatchRange: (path: string, base: string, head: string) =>
    invoke<string>("create_patch_range", { path, base, head }),

  /** Delete a local tag only if it still names `expectedOid`. The remote copy
   * (if any) is untouched and fetch will re-import it — use `deleteRemoteTag`
   * to remove it from the remote too. */
  deleteTag: (path: string, name: string, expectedOid: string) =>
    invoke<string>("delete_tag", { path, name, expectedOid }),

  /** Write a collision-safe `.patch` for one path's working-tree delta. */
  createWorkingTreePatch: (path: string, file: string) =>
    invoke<string>("create_working_tree_patch", { path, file }),
};
