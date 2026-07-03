// Pure helpers for the markdown Preview mode of the review surface: which blob
// the rendered side comes from, and decoding its base64 payload to text.

import type { ChangeSource } from "../../../store/repoTypes";
import type { FileDiff } from "../../../lib/api";

/** Which blob the preview reads: a committed/staged blob (`oid`) or the
 * working-tree file (`file`, repo-relative). Mirrors `BinaryDiff`'s sources. */
export type PreviewSource = { oid?: string; file?: string };

/**
 * Resolve where the preview's content comes from — always the NEW side of the
 * diff (the file as it stands after the change: the worktree copy for an
 * unstaged diff, the index blob for a staged one, the commit's blob otherwise).
 *
 * The unstaged case must read from disk by path: libgit2 reports the worktree
 * side with a computed hash that need not exist in the ODB. Returns null when
 * there is nothing to render — the file was deleted, or a non-worktree diff
 * carries no new-side oid (a gapped multi-commit selection whose merged
 * content is composed in memory and matches no repo blob).
 */
export function previewSource(diff: FileDiff, source: ChangeSource): PreviewSource | null {
  if (diff.status === "D") return null;
  if (source === "unstaged") return { file: diff.path };
  return diff.newOid ? { oid: diff.newOid } : null;
}

/** Decode a base64 payload (from `readBinaryBlob`) as UTF-8 text. */
export function decodeBase64Text(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
