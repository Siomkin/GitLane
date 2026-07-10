// Focused tests for the pure conflict-workspace model (GL-179): label
// derivation, per-file cell mapping, effective selections, next-selection
// builders, stage readiness, and the selected file's resolution flags.
import { describe, expect, it } from "vitest";

import {
  fileCells,
  fileResolutionState,
  pickSelection,
  resolvedTextFor,
  sideLabels,
  stageAllEligible,
  takenBlock,
  toggledLine,
  withBlock,
} from "./conflictWorkspaceModel";
import { parseConflict, type ConflictRegion, type LineSelection } from "../conflictModel";
import type { OperationFile } from "../../../store/repo";

const MARKERS = "start\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> feat\nend\n";
const regions = parseConflict(MARKERS);
const cfIdx = regions.findIndex((r) => r.kind === "cf");
const cf = regions[cfIdx] as ConflictRegion;

const textFile = (path: string, resolved = false): OperationFile => ({
  path,
  kind: "text",
  deletedSide: "",
  resolved,
});

describe("sideLabels", () => {
  it("labels a merge with the head branch", () => {
    expect(sideLabels("merge", "main")).toEqual({
      oursSub: "main (ours)",
      theirsSub: "incoming (theirs)",
    });
  });

  it("falls back to 'current' without a head branch", () => {
    expect(sideLabels("merge", null).oursSub).toBe("current (ours)");
  });

  it("inverts the framing for a rebase (git swaps ours/theirs)", () => {
    expect(sideLabels("rebase", "main")).toEqual({
      oursSub: "rebased onto (ours)",
      theirsSub: "your commit (theirs)",
    });
  });

  it("labels a handoff carry's replayed changes", () => {
    expect(sideLabels("carry", "feat").theirsSub).toBe("carried changes (theirs)");
  });
});

describe("fileCells", () => {
  it("maps only the file's present keys onto hunk indexes", () => {
    const all = { [`a.txt::${cfIdx}`]: "ours", "b.txt::0": "theirs" } as const;
    expect(fileCells(regions, all, "a.txt")).toEqual({ [cfIdx]: "ours" });
    expect(fileCells(regions, all, "c.txt")).toEqual({});
  });
});

describe("pickSelection", () => {
  it("prefers explicit line picks over a whole-hunk decision", () => {
    const explicit: LineSelection = new Set(["b:0"]);
    const picked = pickSelection(regions, cfIdx, { [cfIdx]: "ours" }, { [cfIdx]: explicit });
    expect(picked).toBe(explicit);
  });

  it("derives the picks implied by a whole-hunk decision", () => {
    const picked = pickSelection(regions, cfIdx, { [cfIdx]: "ours" }, {});
    expect([...picked]).toEqual(["a:0"]);
  });

  it("returns an empty selection for context regions", () => {
    expect(pickSelection(regions, 0, {}, {}).size).toBe(0);
  });

  it("treats an empty explicit pick set as no picks (falls back to the decision)", () => {
    const picked = pickSelection(regions, cfIdx, { [cfIdx]: "ours" }, { [cfIdx]: new Set() });
    expect([...picked]).toEqual(["a:0"]);
  });
});

describe("next-selection builders", () => {
  it("toggledLine adds then removes a line", () => {
    const once = toggledLine(new Set(), "a", 0);
    expect([...once]).toEqual(["a:0"]);
    expect(toggledLine(once, "a", 0).size).toBe(0);
  });

  it("withBlock switches a whole side on and off without touching the other", () => {
    const withB = new Set(["b:0"]);
    const on = withBlock(withB, cf, "a", true);
    expect([...on].sort()).toEqual(["a:0", "b:0"]);
    expect([...withBlock(on, cf, "a", false)]).toEqual(["b:0"]);
  });

  it("takenBlock replaces the selection with one side or both", () => {
    expect([...takenBlock(cf, "a")]).toEqual(["a:0"]);
    expect([...takenBlock(cf, "both")].sort()).toEqual(["a:0", "b:0"]);
  });
});

describe("resolvedTextFor / stageAllEligible", () => {
  const content = (text: string, binary = false) => ({ path: "a.txt", content: text, binary });

  it("returns null while a hunk is undecided, the merged text once decided", () => {
    expect(resolvedTextFor(content(MARKERS), "a.txt", {}, {})).toBeNull();
    expect(resolvedTextFor(content(MARKERS), "a.txt", { [`a.txt::${cfIdx}`]: "ours" }, {})).toBe(
      "start\nour line\nend\n",
    );
  });

  it("treats marker-free content as ready to stage as-is", () => {
    expect(resolvedTextFor(content("plain\n"), "a.txt", {}, {})).toBe("plain\n");
  });

  it("never fabricates text for unloaded or binary content", () => {
    expect(resolvedTextFor(undefined, "a.txt", {}, {})).toBeNull();
    expect(resolvedTextFor(content(MARKERS, true), "a.txt", {}, {})).toBeNull();
  });

  it("stageAllEligible needs one unstaged file that is fully decided", () => {
    const files = [textFile("a.txt"), textFile("b.txt")];
    const contentFor = (path: string) => (path === "a.txt" ? content(MARKERS) : undefined);
    expect(stageAllEligible(files, contentFor, {}, {})).toBe(false);
    expect(stageAllEligible(files, contentFor, { [`a.txt::${cfIdx}`]: "ours" }, {})).toBe(true);
    // A staged file no longer counts, even though its decisions would resolve it.
    expect(
      stageAllEligible([textFile("a.txt", true)], contentFor, { [`a.txt::${cfIdx}`]: "ours" }, {}),
    ).toBe(false);
  });

  it("stale cached text never qualifies a file reclassified binary/deleted", () => {
    // A refresh reclassified a.txt (kind changed) while decided text content
    // sits in the cache — it must not be eligible, or Stage all would git-add
    // stale text over the binary/deleted worktree state.
    const decided = { [`a.txt::${cfIdx}`]: "ours" as const };
    const contentFor = () => content("plain resolved\n");
    const binaryKind: OperationFile = { path: "a.txt", kind: "binary", deletedSide: "", resolved: false };
    const deletedKind: OperationFile = { path: "a.txt", kind: "deleted", deletedSide: "ours", resolved: false };
    expect(stageAllEligible([binaryKind], contentFor, decided, {})).toBe(false);
    expect(stageAllEligible([deletedKind], contentFor, decided, {})).toBe(false);
  });
});

describe("fileResolutionState", () => {
  const loaded = { path: "a.txt", content: MARKERS, binary: false };

  it("reports an undecided text file as unresolved", () => {
    const s = fileResolutionState(textFile("a.txt"), loaded, regions, {}, {});
    expect(s).toMatchObject({ totalHunks: 1, decided: 0, resolved: false, staged: false });
  });

  it("reports a fully decided file as resolved", () => {
    const s = fileResolutionState(textFile("a.txt"), loaded, regions, { [cfIdx]: "ours" }, {});
    expect(s).toMatchObject({ decided: 1, resolved: true });
  });

  it("counts marker-free loaded content as resolved (stage as-is)", () => {
    const s = fileResolutionState(
      textFile("a.txt"),
      { path: "a.txt", content: "plain\n", binary: false },
      parseConflict("plain\n"),
      {},
      {},
    );
    expect(s).toMatchObject({ noMarkers: true, resolved: true, totalHunks: 0 });
  });

  it("flags text-classified files with binary content for the whole-file picker", () => {
    const s = fileResolutionState(
      textFile("a.txt"),
      { path: "a.txt", content: "", binary: true },
      [],
      {},
      {},
    );
    expect(s).toMatchObject({ binary: true, wholeFile: true, noMarkers: false });
  });

  it("treats modify/delete conflicts as whole-file", () => {
    const deleted: OperationFile = { path: "gone.txt", kind: "deleted", deletedSide: "ours", resolved: false };
    expect(fileResolutionState(deleted, null, [], {}, {})).toMatchObject({
      wholeFile: true,
      binary: false,
    });
  });

  it("marks malformed markers and keeps the file unresolved", () => {
    const bad = parseConflict("x\n<<<<<<< HEAD\nours\n=======\ntheirs\n"); // truncated hunk
    const s = fileResolutionState(
      textFile("a.txt"),
      { path: "a.txt", content: "", binary: false },
      bad,
      {},
      {},
    );
    expect(s.malformed).toBe(true);
    expect(s.resolved).toBe(false);
  });

  it("reports a staged file as resolved regardless of local decisions", () => {
    const s = fileResolutionState(textFile("a.txt", true), loaded, regions, {}, {});
    expect(s).toMatchObject({ staged: true, resolved: true });
  });
});
