import { beforeEach, describe, expect, it } from "vitest";
import { persistRecents, readRecents, upsertRecent, type RecentRepo } from "./repoSession";

beforeEach(() => localStorage.clear());

describe("readRecents migration from openPaths", () => {
  it("seeds recents from the open-tabs list when the recents key is absent", () => {
    localStorage.setItem("gitlane.openPaths", JSON.stringify(["/a/one", "/b/two", "/c/three"]));
    const recents = readRecents();
    // most-recent-first = reversed tab order
    expect(recents.map((r) => r.path)).toEqual(["/c/three", "/b/two", "/a/one"]);
    expect(recents[0]).toMatchObject({ name: "three", branch: null, lastOpenedAt: 0 });
  });

  it("does not migrate once a recents value exists (even empty)", () => {
    localStorage.setItem("gitlane.openPaths", JSON.stringify(["/a/one"]));
    localStorage.setItem("gitlane.recentRepos", "[]");
    expect(readRecents()).toEqual([]);
  });

  it("returns [] when neither key is present", () => {
    expect(readRecents()).toEqual([]);
  });

  it("round-trips persisted recents", () => {
    const list: RecentRepo[] = [
      { path: "/x/repo", name: "repo", branch: "main", lastOpenedAt: 123 },
    ];
    persistRecents(list);
    expect(readRecents()).toEqual(list);
  });
});

describe("upsertRecent", () => {
  it("moves an existing path to the front without duplicating", () => {
    const base: RecentRepo[] = [
      { path: "/a", name: "a", branch: null, lastOpenedAt: 1 },
      { path: "/b", name: "b", branch: null, lastOpenedAt: 2 },
    ];
    const next = upsertRecent(base, { path: "/b", name: "b", branch: "main", lastOpenedAt: 9 });
    expect(next.map((r) => r.path)).toEqual(["/b", "/a"]);
    expect(next[0].lastOpenedAt).toBe(9);
  });

  it("caps the list at 12, newest first", () => {
    let list: RecentRepo[] = [];
    for (let i = 0; i < 20; i++) {
      list = upsertRecent(list, { path: `/p${i}`, name: `p${i}`, branch: null, lastOpenedAt: i });
    }
    expect(list).toHaveLength(12);
    expect(list[0].path).toBe("/p19");
  });
});
