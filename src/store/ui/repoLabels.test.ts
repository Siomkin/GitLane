import { beforeEach, describe, expect, it } from "vitest";

import { RepoGroupColor, repoGroupCollapsed, repoGroupOf, repoNameOf, useUi } from "@/store/ui";
// The sanitizers back the persist `merge` hook rather than the public store
// surface, so they are imported from the slice they live in.
import {
  persistedRepoLabels,
  sanitizeCollapsedRepoGroups,
  sanitizeRepoGroups,
  sanitizeRepoLabels,
} from "./repoLabels";

const IDENTITY = "/dev/acme/frontend";
const OTHER = "/dev/other/frontend";

beforeEach(() => {
  useUi.setState({ repoGroups: [], repoLabelsByIdentity: {}, collapsedRepoGroups: [] });
});

describe("custom repository names", () => {
  it("sets and clears a display name", () => {
    useUi.getState().setRepoName(IDENTITY, "Acme · frontend");
    expect(repoNameOf(useUi.getState(), IDENTITY)).toBe("Acme · frontend");

    // An empty submission is how the rename prompt clears a custom name.
    useUi.getState().setRepoName(IDENTITY, "");
    expect(repoNameOf(useUi.getState(), IDENTITY)).toBeNull();
    // Nothing left to remember about the repo, so it leaves the map entirely.
    expect(useUi.getState().repoLabelsByIdentity[IDENTITY]).toBeUndefined();
  });

  it("keeps a repository's group when its name is cleared", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(IDENTITY, id);
    useUi.getState().setRepoName(IDENTITY, "frontend (acme)");
    useUi.getState().setRepoName(IDENTITY, null);

    expect(repoNameOf(useUi.getState(), IDENTITY)).toBeNull();
    expect(repoGroupOf(useUi.getState(), IDENTITY)?.id).toBe(id);
  });

  it("names are per identity", () => {
    useUi.getState().setRepoName(IDENTITY, "Acme");
    expect(repoNameOf(useUi.getState(), OTHER)).toBeNull();
  });
});

describe("repository groups", () => {
  it("assigns, reassigns, and removes a repository's group", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    const personal = useUi.getState().createRepoGroup("Personal")!;

    useUi.getState().assignRepoGroup(IDENTITY, acme);
    expect(repoGroupOf(useUi.getState(), IDENTITY)?.name).toBe("Acme");

    useUi.getState().assignRepoGroup(IDENTITY, personal);
    expect(repoGroupOf(useUi.getState(), IDENTITY)?.name).toBe("Personal");

    useUi.getState().assignRepoGroup(IDENTITY, null);
    expect(repoGroupOf(useUi.getState(), IDENTITY)).toBeNull();
  });

  it("keeps an emptied group available for another repository", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(IDENTITY, acme);
    useUi.getState().assignRepoGroup(IDENTITY, null);

    expect(useUi.getState().repoGroups.map((g) => g.name)).toEqual(["Acme"]);
  });

  it("cycles colours so consecutive groups look distinct", () => {
    useUi.getState().createRepoGroup("One")!;
    useUi.getState().createRepoGroup("Two")!;
    const [first, second] = useUi.getState().repoGroups;
    expect(first.color).not.toBe(second.color);
  });

  it("renames a group without touching membership", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(IDENTITY, id);
    useUi.getState().renameRepoGroup(id, "Acme Corp");

    expect(repoGroupOf(useUi.getState(), IDENTITY)?.name).toBe("Acme Corp");
    // A blank rename is refused rather than leaving a nameless group.
    useUi.getState().renameRepoGroup(id, "   ");
    expect(repoGroupOf(useUi.getState(), IDENTITY)?.name).toBe("Acme Corp");
  });

  it("leaves members ungrouped — but named — when a group is deleted", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(IDENTITY, id);
    useUi.getState().setRepoName(IDENTITY, "Acme · frontend");
    useUi.getState().deleteRepoGroup(id);

    expect(repoGroupOf(useUi.getState(), IDENTITY)).toBeNull();
    expect(repoNameOf(useUi.getState(), IDENTITY)).toBe("Acme · frontend");
  });
});

describe("collapsing a group", () => {
  it("folds and unfolds a group", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(false);

    useUi.getState().toggleRepoGroupCollapsed(id);
    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(true);

    useUi.getState().toggleRepoGroupCollapsed(id);
    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(false);
  });

  it("collapses one group without touching its neighbour", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    const beta = useUi.getState().createRepoGroup("Beta")!;
    useUi.getState().toggleRepoGroupCollapsed(acme);

    expect(repoGroupCollapsed(useUi.getState(), acme)).toBe(true);
    expect(repoGroupCollapsed(useUi.getState(), beta)).toBe(false);
  });

  it("forgets a deleted group's collapsed entry rather than accumulating it", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().toggleRepoGroupCollapsed(id);
    useUi.getState().deleteRepoGroup(id);

    // Keyed by group id, so nothing else would ever clean it up.
    expect(useUi.getState().collapsedRepoGroups).toEqual([]);
  });

  it("reads a deleted group's leftover id as not collapsed", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().toggleRepoGroupCollapsed(id);
    useUi.getState().deleteRepoGroup(id);

    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(false);
  });

  it("collapsing leaves names and membership alone", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(IDENTITY, id);
    useUi.getState().setRepoName(IDENTITY, "Frontend");
    useUi.getState().toggleRepoGroupCollapsed(id);

    expect(repoGroupOf(useUi.getState(), IDENTITY)?.id).toBe(id);
    expect(repoNameOf(useUi.getState(), IDENTITY)).toBe("Frontend");
  });

  it("persists the collapsed set with the other group preferences", () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().toggleRepoGroupCollapsed(id);

    expect(persistedRepoLabels(useUi.getState()).collapsedRepoGroups).toEqual([id]);
  });
});

describe("creating a group", () => {
  it("refuses a blank name", () => {
    expect(useUi.getState().createRepoGroup("   ")).toBeNull();
    expect(useUi.getState().createRepoGroup("")).toBeNull();
    expect(useUi.getState().repoGroups).toEqual([]);
  });

  it("trims the name it stores", () => {
    const id = useUi.getState().createRepoGroup("  Acme  ");
    expect(useUi.getState().repoGroups.find((g) => g.id === id)?.name).toBe("Acme");
  });
});

describe("restoring corrupt preferences", () => {
  it("degrades to no groups rather than throwing", () => {
    expect(sanitizeRepoGroups(undefined)).toEqual([]);
    expect(sanitizeRepoGroups("nonsense")).toEqual([]);
    expect(sanitizeRepoGroups([{ id: "a" }, null, 7])).toEqual([]);
    expect(sanitizeRepoLabels(undefined)).toEqual({});
    expect(sanitizeRepoLabels([1, 2])).toEqual({});
    expect(sanitizeRepoLabels({ "/dev/x": { name: 3, groupId: false } })).toEqual({});
    expect(sanitizeCollapsedRepoGroups(undefined)).toEqual([]);
    expect(sanitizeCollapsedRepoGroups("g1")).toEqual([]);
    expect(sanitizeCollapsedRepoGroups([1, null, "", { id: "g" }])).toEqual([]);
  });

  it("rehydrates a blob written before groups could collapse", () => {
    // The pre-collapse shape: names and groups, no `collapsedRepoGroups` key.
    expect(sanitizeCollapsedRepoGroups(undefined)).toEqual([]);
    // And keeps the readable ids out of a half-written one, without duplicates.
    expect(sanitizeCollapsedRepoGroups(["g1", "g1", 7, "g2"])).toEqual(["g1", "g2"]);
  });

  it("keeps a group whose colour is unknown, redrawn in the first colour", () => {
    expect(sanitizeRepoGroups([{ id: "a", name: "Acme", color: "chartreuse" }])).toEqual([
      { id: "a", name: "Acme", color: RepoGroupColor.Blue },
    ]);
  });

  it("keeps the readable half of a partially corrupt map", () => {
    expect(
      sanitizeRepoLabels({ "/dev/x": { name: "X" }, "/dev/y": "junk", "/dev/z": { groupId: "g" } }),
    ).toEqual({ "/dev/x": { name: "X" }, "/dev/z": { groupId: "g" } });
  });
});
