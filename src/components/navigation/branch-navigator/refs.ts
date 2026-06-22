import type { CommitNode } from "@/lib/api";

/** Which kind of ref a navigator row represents. Tags are navigate-only — never a
 * drag source or checkout/context-menu target. */
export type RowKind = "local" | "remote" | "tag";

/** A navigable ref row: a display name plus the commit oid to jump to. `oid` is
 * absent when the tip can't be resolved (e.g. a branch with no `target` whose tip
 * is outside the loaded graph window). */
export interface RefItem {
  name: string;
  oid?: string;
}

/** Map every ref name (branch / remote / tag) to the oid of the commit it sits on,
 * so a navigator pick can scroll the graph to that commit. First-seen wins; a ref
 * sits on exactly one commit, so the dedupe is harmless. */
export function makeRefOidResolver(commits: CommitNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (!map.has(ref.name)) map.set(ref.name, commit.id);
    }
  }
  return map;
}

/** Tags visible in the loaded graph window, derived from commit refs (there's no
 * dedicated tag-list command — they ride along on the graph). */
export function collectTags(commits: CommitNode[]): RefItem[] {
  const seen = new Set<string>();
  const out: RefItem[] = [];
  for (const commit of commits) {
    for (const ref of commit.refs) {
      if (ref.kind === "tag" && !seen.has(ref.name)) {
        seen.add(ref.name);
        out.push({ name: ref.name, oid: commit.id });
      }
    }
  }
  return out;
}
