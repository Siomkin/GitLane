// Custom repository display names and the user-defined groups they belong to.
//
// Keyed by *repository identity* (`lib/tabs.ts`'s `tabIdentity` — a linked
// worktree resolves to its main checkout's path), so renaming or grouping a
// repository covers its worktree tabs too. Persisted with the rest of the ui
// store's view preferences: names and groups must outlive the recents list,
// which is capped and cleared by a button, so `repoSession.ts` is not a home
// for them.

import type { SliceSet } from "./slice";
import { persistedKeys } from "./slice";

/** The colour a group is drawn in. Fixed set — named, never a raw colour
 * string at a call site, and deliberately not the graph lane palette (lane
 * colours mean "this commit's lane", and reusing them would imply a link). */
export const RepoGroupColor = {
  Blue: "blue",
  Green: "green",
  Amber: "amber",
  Violet: "violet",
  Rose: "rose",
  Teal: "teal",
} as const;
export type RepoGroupColor = (typeof RepoGroupColor)[keyof typeof RepoGroupColor];

export const REPO_GROUP_COLORS: RepoGroupColor[] = Object.values(RepoGroupColor);

/** Tailwind classes per colour: the dot used where a swatch identifies a group
 * (menu rows, recents sections). The tab strip's group name is deliberately
 * desaturated (design 1C), so there is no filled-chip variant. */
export const repoGroupColorStyles: Record<RepoGroupColor, { dot: string }> = {
  [RepoGroupColor.Blue]: {
    dot: "bg-blue-500 dark:bg-blue-400",
  },
  [RepoGroupColor.Green]: {
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  [RepoGroupColor.Amber]: {
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  [RepoGroupColor.Violet]: {
    dot: "bg-violet-500 dark:bg-violet-400",
  },
  [RepoGroupColor.Rose]: {
    dot: "bg-rose-500 dark:bg-rose-400",
  },
  [RepoGroupColor.Teal]: {
    dot: "bg-teal-500 dark:bg-teal-400",
  },
};

/** A user-created repository group. Identified by `id`, so two groups may
 * share a name — forbidding that would be validation for no user benefit. */
export interface RepoGroup {
  id: string;
  name: string;
  color: RepoGroupColor;
}

/** What the user has set for one repository identity. Both fields independent:
 * a rename does not imply a group, nor a group a rename. */
export interface RepoLabel {
  /** Display name replacing the folder-derived label. Absent = use the folder. */
  name?: string;
  /** Group membership. Absent (or naming a deleted group) = ungrouped. */
  groupId?: string;
}

export interface RepoLabelsSlice {
  /** User-created groups, in creation order — the order sections appear in. */
  repoGroups: RepoGroup[];
  /** Repository identity path → its custom name / group. Persisted. */
  repoLabelsByIdentity: Record<string, RepoLabel>;
  /** Ids of the groups the tab strip draws folded to their pill. Keyed by
   * group, not by repository: collapsing is a property of the group. An id
   * whose group is gone reads as "not collapsed" (see `repoGroupCollapsed`),
   * so deleting a group needs no sweep here. */
  collapsedRepoGroups: string[];

  /** Set (or, with `null`/blank, clear) a repository's custom display name. */
  setRepoName: (identity: string, name: string | null) => void;
  /** Create a group and return its id, or `null` for a blank name. The colour
   * cycles through the fixed set so consecutive groups look distinct without
   * the user picking one. */
  createRepoGroup: (name: string) => string | null;
  renameRepoGroup: (groupId: string, name: string) => void;
  /** Delete a group; its members become ungrouped (their names are kept). */
  deleteRepoGroup: (groupId: string) => void;
  /** Assign a repository to a group, or with `null` remove it from its group. */
  assignRepoGroup: (identity: string, groupId: string | null) => void;
  /** Fold a group down to its pill, or unfold it. */
  toggleRepoGroupCollapsed: (groupId: string) => void;
}

export const persistedRepoLabels = (s: RepoLabelsSlice) =>
  persistedKeys(s, ["repoGroups", "repoLabelsByIdentity", "collapsedRepoGroups"]);

/** Drop `identity` when nothing is left to remember about it, so a rename
 * undone and a group left behind don't accumulate empty records. */
function withLabel(
  labels: Record<string, RepoLabel>,
  identity: string,
  patch: RepoLabel,
): Record<string, RepoLabel> {
  const next = { ...labels[identity], ...patch };
  if (next.name === undefined && next.groupId === undefined) {
    const { [identity]: _dropped, ...rest } = labels;
    return rest;
  }
  return { ...labels, [identity]: next };
}

/** Restored preferences are user-editable JSON on disk: a corrupt or
 * hand-edited value must degrade to "no groups" rather than break the app on
 * launch (a group with an unknown colour is kept, redrawn in the first one). */
export function sanitizeRepoGroups(value: unknown): RepoGroup[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((g): RepoGroup[] => {
    if (!g || typeof g !== "object") return [];
    const { id, name, color } = g as Partial<RepoGroup>;
    if (typeof id !== "string" || typeof name !== "string") return [];
    const known = REPO_GROUP_COLORS.includes(color as RepoGroupColor);
    return [{ id, name, color: known ? (color as RepoGroupColor) : RepoGroupColor.Blue }];
  });
}

export function sanitizeRepoLabels(value: unknown): Record<string, RepoLabel> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([identity, label]) => {
      if (!label || typeof label !== "object") return [];
      const { name, groupId } = label as Partial<RepoLabel>;
      const entry: RepoLabel = {};
      if (typeof name === "string" && name.length > 0) entry.name = name;
      if (typeof groupId === "string") entry.groupId = groupId;
      return Object.keys(entry).length > 0 ? [[identity, entry] as const] : [];
    }),
  );
}

/** Same contract as the sanitizers above: a hand-edited or half-written value
 * degrades to "nothing collapsed" rather than breaking launch. */
export function sanitizeCollapsedRepoGroups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

export function createRepoLabelsSlice(set: SliceSet<RepoLabelsSlice>): RepoLabelsSlice {
  return {
    repoGroups: [],
    repoLabelsByIdentity: {},
    collapsedRepoGroups: [],

    setRepoName: (identity, name) =>
      set((s) => {
        const trimmed = name?.trim();
        return {
          repoLabelsByIdentity: withLabel(s.repoLabelsByIdentity, identity, {
            name: trimmed ? trimmed : undefined,
          }),
        };
      }),

    // Blank is refused here as well as in the prompt: `renameRepoGroup` already
    // refuses it, and a group named "" would be a chip the user cannot see or
    // find again.
    createRepoGroup: (name) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const id = crypto.randomUUID();
      set((s) => ({
        repoGroups: [
          ...s.repoGroups,
          {
            id,
            name: trimmed,
            color: REPO_GROUP_COLORS[s.repoGroups.length % REPO_GROUP_COLORS.length],
          },
        ],
      }));
      return id;
    },

    renameRepoGroup: (groupId, name) =>
      set((s) => {
        const trimmed = name.trim();
        if (!trimmed) return s;
        return {
          repoGroups: s.repoGroups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)),
        };
      }),

    // Members are left with a dangling `groupId` rather than swept: reading a
    // group that isn't there already means "ungrouped" (see `repoGroupOf`), and
    // rewriting every label here would be a second place to keep in step. The
    // collapsed set *is* swept, because nothing else ever would: it is keyed by
    // group id, so a deleted group's entry is unreachable dead weight that
    // would accumulate in the persisted preferences forever.
    deleteRepoGroup: (groupId) =>
      set((s) => ({
        repoGroups: s.repoGroups.filter((g) => g.id !== groupId),
        collapsedRepoGroups: s.collapsedRepoGroups.filter((id) => id !== groupId),
      })),

    assignRepoGroup: (identity, groupId) =>
      set((s) => ({
        repoLabelsByIdentity: withLabel(s.repoLabelsByIdentity, identity, {
          groupId: groupId ?? undefined,
        }),
      })),

    toggleRepoGroupCollapsed: (groupId) =>
      set((s) => ({
        collapsedRepoGroups: s.collapsedRepoGroups.includes(groupId)
          ? s.collapsedRepoGroups.filter((id) => id !== groupId)
          : [...s.collapsedRepoGroups, groupId],
      })),
  };
}

/** Just the stored maps — what the lookups below read, so a component can
 * subscribe to those two fields instead of the whole slice. */
export type RepoLabelsState = Pick<RepoLabelsSlice, "repoGroups" | "repoLabelsByIdentity">;

/** What `repoGroupCollapsed` reads — the collapse flag and the groups it is
 * checked against. Separate from `RepoLabelsState` so the name/group lookups
 * keep subscribing to two fields, not three. */
export type RepoCollapseState = Pick<RepoLabelsSlice, "repoGroups" | "collapsedRepoGroups">;

/** The group a repository identity belongs to, or null when ungrouped — the
 * one place a dangling `groupId` (deleted group) resolves to "no group". */
export function repoGroupOf(s: RepoLabelsState, identity: string): RepoGroup | null {
  const groupId = s.repoLabelsByIdentity[identity]?.groupId;
  if (!groupId) return null;
  return s.repoGroups.find((g) => g.id === groupId) ?? null;
}

/** Whether a group is drawn folded to its pill. The one place a collapsed id
 * whose group has been deleted resolves to "not collapsed". */
export function repoGroupCollapsed(s: RepoCollapseState, groupId: string): boolean {
  return s.collapsedRepoGroups.includes(groupId) && s.repoGroups.some((g) => g.id === groupId);
}

/** The custom display name for a repository identity, or null when unnamed. */
export function repoNameOf(s: RepoLabelsState, identity: string): string | null {
  return s.repoLabelsByIdentity[identity]?.name ?? null;
}
