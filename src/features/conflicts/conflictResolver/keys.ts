// Keying per-hunk state, and the fingerprints that decide when a choice made
// against one version of a hunk is no longer valid for what is on disk.

import type { ConflictFileContent } from "@/lib/api";
import { hunkFingerprint, parseConflict } from "@/features/conflicts/conflictModel";

/** Composite key for per-hunk state — one file's hunk index. */
export const cell = (path: string, idx: number) => `${path}::${idx}`;

/** Immutable "delete this key" updater. Returns the same map when the key is
 * absent, so a no-op never re-renders. */
export const without =
  <T,>(key: string) =>
  (m: Record<string, T>): Record<string, T> => {
    if (!(key in m)) return m;
    const next = { ...m };
    delete next[key];
    return next;
  };

/** Key-matcher for one file's cells. A key belongs to `path` only when
 * everything after the prefix is a hunk index — a bare prefix match would also
 * hit a file literally named "<path>::something" (GL-178 review). */
export const cellMatcher = (path: string) => {
  const prefix = `${path}::`;
  return (k: string) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length));
};

/** Per-cell fingerprints of a file's conflict hunks (none for binary content). */
export function printsOf(path: string, content: ConflictFileContent): Record<string, string> {
  const out: Record<string, string> = {};
  if (content.binary) return out;
  parseConflict(content.content).forEach((region, idx) => {
    if (region.kind === "cf") out[cell(path, idx)] = hunkFingerprint(region);
  });
  return out;
}

/** Fingerprint of the hunk at one region index, when it is a conflict hunk. */
export function printAt(content: ConflictFileContent | undefined, idx: number): string | undefined {
  if (!content || content.binary) return undefined;
  const region = parseConflict(content.content)[idx];
  return region?.kind === "cf" ? hunkFingerprint(region) : undefined;
}
