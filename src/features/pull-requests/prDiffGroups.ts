// Pure grouping model for the PR Diff tab (GL-186): `gh pr diff --patch` is
// per-commit, so the file list arrives ordered by commit and a path touched by
// several commits appears once per commit. Grouping is by CONSECUTIVE runs of
// the same commit oid — deliberately not a map keyed by oid — so the groups
// mirror the patch's own segment order. No React, no IPC.
import type { FileDiff } from "../../lib/api/git";

/** One commit's worth of consecutive file cards. `index` is the file's global
 * position, kept for stable card keys (same-path files repeat across commits).
 * Diffs without attribution (older backend payloads) collapse into one group,
 * which renders headerless — identical to the pre-grouping layout. */
export interface CommitGroup {
  oid?: string;
  subject?: string;
  files: { file: FileDiff; index: number }[];
}

export function groupByCommit(diffs: FileDiff[]): CommitGroup[] {
  const groups: CommitGroup[] = [];
  diffs.forEach((file, index) => {
    const last = groups[groups.length - 1];
    if (last && last.oid === file.commitOid) {
      last.files.push({ file, index });
    } else {
      groups.push({ oid: file.commitOid, subject: file.commitSubject, files: [{ file, index }] });
    }
  });
  return groups;
}

/** Headers only when the diff actually spans commits: single-commit PRs and
 * attribution-less payloads keep the flat, header-free layout. */
export function showCommitHeaders(groups: CommitGroup[]): boolean {
  return groups.length > 1;
}
