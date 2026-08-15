import { describe, it, expect } from "vitest";
import { NavCategory, RowKind } from "./refs";
import { buildNavItems, navItemHeight, navItemKey, NavItemKind, type NavListItem } from "./navItems";
import type { NavigatorSections } from "./useNavigatorSections";

const ref = (name: string, over: Partial<{ pinned: boolean; current: boolean }> = {}) => ({
  name,
  oid: "c1",
  pinned: false,
  ...over,
});
const section = <T,>(items: T[], separatorAt: number | null = null) => ({
  items,
  separatorAt,
  total: items.length,
});

const sections = (over: Partial<NavigatorSections> = {}): NavigatorSections =>
  ({
    locals: section([ref("main", { current: true }), ref("feature")]),
    remotes: section([ref("origin/main")]),
    tags: section([ref("v1.0.0")]),
    worktrees: section([
      { wt: { name: "wt", path: "/wt", branch: "feature", isMain: false }, oid: "c1", isActive: false, label: "feature" },
    ]),
    stashes: section([{ stash: { index: 0, message: "wip", oid: "s1", timestamp: 0, baseOid: "c1", baseTimestamp: 0, context: [] } }]),
    detachedRemovable: [],
    head: "main",
    filtering: false,
    isEmpty: false,
    ...over,
  }) as NavigatorSections;

const kinds = (items: NavListItem[]) => items.map((i) => i.kind);
const labels = (items: NavListItem[]) =>
  items.map((i) =>
    i.kind === NavItemKind.Header
      ? `#${i.label}`
      : i.kind === NavItemKind.Ref
        ? i.item.name
        : i.kind,
  );

describe("buildNavItems", () => {
  it("interleaves headers with their rows in All", () => {
    const items = buildNavItems(NavCategory.All, sections(), { showSweep: false });
    expect(labels(items)).toEqual([
      "#Branches", "main", "feature",
      "#Remotes", "origin/main",
      "#Worktrees", "worktree",
      "#Tags", "v1.0.0",
      "#Stashes", "stash",
    ]);
  });

  it("omits a section header when that section has no visible rows", () => {
    const items = buildNavItems(
      NavCategory.All,
      sections({ tags: section([]), stashes: section([]) }),
      { showSweep: false },
    );
    expect(labels(items)).not.toContain("#Tags");
    expect(labels(items)).not.toContain("#Stashes");
  });

  it("places the pinned separator between the runs it divides", () => {
    const items = buildNavItems(
      NavCategory.Branches,
      sections({ locals: section([ref("pinned", { pinned: true }), ref("plain")], 1) }),
      { showSweep: false },
    );
    expect(kinds(items)).toEqual([NavItemKind.Ref, NavItemKind.Separator, NavItemKind.Ref]);
  });

  it("counts rows in a header without letting the separator inflate it", () => {
    const items = buildNavItems(
      NavCategory.All,
      sections({ locals: section([ref("a", { pinned: true }), ref("b")], 1) }),
      { showSweep: false },
    );
    const header = items.find((i) => i.kind === NavItemKind.Header && i.label === "Branches");
    expect(header).toMatchObject({ count: 2 });
  });

  it("hangs the sweep on the Worktrees header in All, but gives it its own row in the category", () => {
    const all = buildNavItems(NavCategory.All, sections(), { showSweep: true });
    expect(all.find((i) => i.kind === NavItemKind.Header && i.label === "Worktrees")).toMatchObject({
      sweep: true,
    });
    expect(kinds(all)).not.toContain(NavItemKind.Sweep);

    const category = buildNavItems(NavCategory.Worktrees, sections(), { showSweep: true });
    expect(kinds(category)).toEqual([NavItemKind.Sweep, NavItemKind.Worktree]);
  });

  it("returns a flat list for a single category", () => {
    const items = buildNavItems(NavCategory.Tags, sections(), { showSweep: false });
    expect(kinds(items)).toEqual([NavItemKind.Ref]);
  });

  it("gives every item a height, and keys that survive a name shared across kinds", () => {
    const items = buildNavItems(NavCategory.All, sections(), { showSweep: false });
    for (const item of items) expect(navItemHeight(item)).toBeGreaterThan(0);

    const branch: NavListItem = { kind: NavItemKind.Ref, rowKind: RowKind.Local, item: ref("release") };
    const tag: NavListItem = { kind: NavItemKind.Ref, rowKind: RowKind.Tag, item: ref("release") };
    expect(navItemKey(branch, 0)).not.toBe(navItemKey(tag, 1));

    const keys = items.map(navItemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
