import type { ComponentType, SVGProps } from "react";
import { BranchKind, RefKind, type CommitNode } from "@/lib/api";
import { BranchIcon, CloudIcon, ListIcon, StashIcon, TagIcon, TreeIcon } from "@/components/ui/icons";

/** Which kind of ref a navigator row represents: a branch (local/remote) plus
 * tags, which are navigate-only — never a drag source or checkout/context-menu
 * target. Compare against `RowKind.Tag`, not `"tag"`. */
export const RowKind = {
  Local: BranchKind.Local,
  Remote: BranchKind.Remote,
  Tag: "tag",
} as const;
export type RowKind = (typeof RowKind)[keyof typeof RowKind];

/** The navigator's category tabs (the left sidebar of the two-pane palette).
 * "All" shows every section grouped under headers; the rest show one flat list.
 * Compare against these consts, never the raw strings. */
export const NavCategory = {
  All: "all",
  Branches: "branches",
  Remotes: "remotes",
  Worktrees: "worktrees",
  Tags: "tags",
  Stashes: "stashes",
} as const;
export type NavCategory = (typeof NavCategory)[keyof typeof NavCategory];

/** One navigator category: its sidebar label and icon, the singular / plural
 * nouns the search placeholder, match count and empty state speak in, and the
 * `NavigatorSections` key it lists (none for "All", which sums every section).
 * Adding a category is one entry here. */
export interface NavCategoryDef {
  key: NavCategory;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  nouns: { one: string; many: string };
  section: "locals" | "remotes" | "worktrees" | "tags" | "stashes" | null;
}

/** Sidebar order mirrors the design (All first, then ref kinds); Stashes is a
 * GitLane addition the mockup doesn't carry. */
export const NAV_CATEGORIES: readonly NavCategoryDef[] = [
  { key: NavCategory.All, label: "All", Icon: ListIcon, nouns: { one: "ref", many: "refs" }, section: null },
  { key: NavCategory.Branches, label: "Branches", Icon: BranchIcon, nouns: { one: "branch", many: "branches" }, section: "locals" },
  { key: NavCategory.Remotes, label: "Remotes", Icon: CloudIcon, nouns: { one: "remote", many: "remotes" }, section: "remotes" },
  { key: NavCategory.Worktrees, label: "Worktrees", Icon: TreeIcon, nouns: { one: "worktree", many: "worktrees" }, section: "worktrees" },
  { key: NavCategory.Tags, label: "Tags", Icon: TagIcon, nouns: { one: "tag", many: "tags" }, section: "tags" },
  { key: NavCategory.Stashes, label: "Stashes", Icon: StashIcon, nouns: { one: "stash", many: "stashes" }, section: "stashes" },
];

/** Stable identity of a pinnable ref in the persisted pin map
 * (`ui.pinnedNavRefsByRepo[repoPath]`) — kind-scoped so a tag can't collide with a branch of
 * the same name. */
export function pinKey(kind: RowKind, name: string): string {
  return `${kind}|${name}`;
}

/** A navigable ref row: a display name plus the commit oid to jump to. `oid` is
 * absent when the tip can't be resolved (e.g. a branch with no `target` whose tip
 * is outside the loaded graph window). */
export interface RefItem {
  name: string;
  oid?: string;
  /** Exact tag-ref target used only by the destructive tag menu. */
  refOid?: string;
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
      if (ref.kind === RefKind.Tag && !seen.has(ref.name)) {
        seen.add(ref.name);
        out.push({ name: ref.name, oid: commit.id, refOid: ref.targetOid ?? commit.id });
      }
    }
  }
  return out;
}
