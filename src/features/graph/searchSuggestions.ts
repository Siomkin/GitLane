// Pure, IPC-free suggestion builders for the advanced search's autosuggest
// fields. Kept out of the component so the matching/completion rules are
// testable in isolation: authors come from the loaded graph's commits
// (newest-first, so recent collaborators surface first), revisions from the
// branch list plus the loaded graph's tag refs, and range completion only
// replaces the token after the last `..`.

import { BranchKind, RefKind, type BranchInfo, type CommitNode } from "@/lib/api";
import type { SuggestItem } from "@/components/ui/SuggestInput";

export const MAX_SUGGESTIONS = 8;

/** Distinct authors of the loaded commits whose name or email contains the
 * query (case-insensitive; an empty query lists them all for browsing).
 * Picking inserts the name — the backend matches it against `name email`. */
export function authorSuggestions(commits: CommitNode[], query: string): SuggestItem[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const items: SuggestItem[] = [];
  for (const commit of commits) {
    if (items.length >= MAX_SUGGESTIONS) break;
    const key = `${commit.authorName} ${commit.authorEmail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const haystack = `${commit.authorName} ${commit.authorEmail}`.toLowerCase();
    if (q && !haystack.includes(q)) continue;
    items.push({
      value: commit.authorName || commit.authorEmail,
      label: commit.authorName || commit.authorEmail,
      hint: commit.authorEmail,
    });
  }
  return items;
}

/** The revision-field token being completed: everything after the last `..`
 * (the whole value when there is no range). */
function revisionToken(value: string): string {
  const split = value.lastIndexOf("..");
  return (split >= 0 ? value.slice(split + 2) : value).trim();
}

/** Branch names (local first), the loaded graph's tag names, and HEAD, whose
 * name contains the token under the caret (empty token lists them all). */
export function revisionSuggestions(
  branches: BranchInfo[],
  commits: CommitNode[],
  value: string,
): SuggestItem[] {
  const token = revisionToken(value).toLowerCase();
  const candidates: SuggestItem[] = [];
  for (const kind of [BranchKind.Local, BranchKind.Remote]) {
    for (const branch of branches) {
      if (branch.kind !== kind) continue;
      candidates.push({
        value: branch.name,
        hint: kind === BranchKind.Remote ? "remote" : "branch",
      });
    }
  }
  const tagsSeen = new Set<string>();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.kind !== RefKind.Tag || tagsSeen.has(ref.name)) continue;
      tagsSeen.add(ref.name);
      candidates.push({ value: ref.name, hint: "tag" });
    }
  }
  candidates.push({ value: "HEAD" });
  return candidates
    .filter((item) => !token || item.value.toLowerCase().includes(token))
    .slice(0, MAX_SUGGESTIONS);
}

/** Land a picked revision in the field: complete only the token after the
 * last `..` so range queries build up naturally. */
export function completeRevision(value: string, pick: string): string {
  const split = value.lastIndexOf("..");
  return split >= 0 ? value.slice(0, split + 2) + pick : pick;
}
