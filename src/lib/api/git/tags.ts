// Local tag writes, and the patch files generated from a commit, a range, or the
// working tree. Remote tag pushes and deletes live in `remotes`.
// Mirrors `commands/tags.rs`.

import { invoke } from "@/lib/api/invoke";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

export const tagsApi = {
  /** Create a lightweight tag at the captured `sha`. */
  createTag: async (path: string, name: string, sha: string) =>
    parse(z.string(), await invoke("create_tag", { path, name, sha }), "create_tag"),

  /** Create an annotated tag (tagger + `message`) at the captured `sha`. */
  createAnnotatedTag: async (path: string, name: string, message: string, sha: string) =>
    parse(
      z.string(),
      await invoke("create_annotated_tag", { path, name, message, sha }),
      "create_annotated_tag",
    ),

  /** Write a `.patch` file for the single commit `sha` into the worktree
   * (`git format-patch -1`); resolves with the created filename. */
  createPatch: async (path: string, sha: string) =>
    parse(z.string(), await invoke("create_patch", { path, sha }), "create_patch"),

  /** Write one mailbox `.patch` file covering the contiguous `base..head`
   * range (`git format-patch`); resolves with the created filename. Callers
   * gate this on a first-parent-contiguous selection. */
  createPatchRange: async (path: string, base: string, head: string) =>
    parse(
      z.string(),
      await invoke("create_patch_range", { path, base, head }),
      "create_patch_range",
    ),

  /** Delete a local tag only if it still names `expectedOid`. The remote copy
   * (if any) is untouched and fetch will re-import it — use `deleteRemoteTag`
   * to remove it from the remote too. */
  deleteTag: async (path: string, name: string, expectedOid: string) =>
    parse(z.string(), await invoke("delete_tag", { path, name, expectedOid }), "delete_tag"),

  /** Write a collision-safe `.patch` for one path's working-tree delta. */
  createWorkingTreePatch: async (path: string, file: string) =>
    parse(
      z.string(),
      await invoke("create_working_tree_patch", { path, file }),
      "create_working_tree_patch",
    ),
};
