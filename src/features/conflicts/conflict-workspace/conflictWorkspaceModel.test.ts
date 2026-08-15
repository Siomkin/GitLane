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
  stagePlanFor,
  takenBlock,
  toggledLine,
  withBlock,
  type Resolutions,
} from "./conflictWorkspaceModel";
import {
  hunkFingerprint,
  parseConflict,
  type ConflictRegion,
  type HunkChoice,
  type WholeDecision,
} from "@/features/conflicts/conflictModel";
import type { OperationFile } from "@/store/repo";

/** The resolver's state, defaulted — each test names only what it sets. */
const res = (over: Partial<Resolutions> = {}): Resolutions => ({
  choices: {},
  fileText: {},
  ...over,
});

const MARKERS = "start\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> feat\nend\n";
const regions = parseConflict(MARKERS);
const cfIdx = regions.findIndex((r) => r.kind === "cf");
const cf = regions[cfIdx] as ConflictRegion;
// Choices default to the fingerprint of MARKERS' hunk — the print a choice
// made against that hunk carries (recorded by the resolver).
const whole = (decision: WholeDecision, print = hunkFingerprint(cf)): HunkChoice => ({
  kind: "whole",
  decision,
  print,
});
const picks = (keys: string[], print = hunkFingerprint(cf)): HunkChoice => ({
  kind: "lines",
  selection: new Set(keys),
  print,
});
const custom = (ls: string[], print = hunkFingerprint(cf)): HunkChoice => ({
  kind: "custom",
  lines: ls,
  print,
});

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
  it("prefers a \"lines\" choice's picks over deriving from a whole-hunk decision", () => {
    const explicit = new Set(["b:0"]);
    const picked = pickSelection(regions, cfIdx, {
      [cfIdx]: { kind: "lines", selection: explicit, print: "p" },
    });
    expect(picked).toBe(explicit);
  });

  it("derives the picks implied by a whole-hunk decision", () => {
    const picked = pickSelection(regions, cfIdx, { [cfIdx]: whole("ours") });
    expect([...picked]).toEqual(["a:0"]);
  });

  it("returns an empty selection for context regions", () => {
    expect(pickSelection(regions, 0, {}).size).toBe(0);
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
    expect(resolvedTextFor(content(MARKERS), "a.txt", res())).toBeNull();
    expect(
      resolvedTextFor(content(MARKERS), "a.txt", res({ choices: { [`a.txt::${cfIdx}`]: whole("ours") } })),
    ).toBe("start\nour line\nend\n");
  });

  it("treats marker-free content as ready to stage as-is", () => {
    expect(resolvedTextFor(content("plain\n"), "a.txt", res())).toBe("plain\n");
  });

  it("never fabricates text for unloaded or binary content", () => {
    expect(resolvedTextFor(undefined, "a.txt", res())).toBeNull();
    expect(resolvedTextFor(content(MARKERS, true), "a.txt", res())).toBeNull();
  });

  it("treats a choice whose hunk print no longer matches as undecided (GL-180)", () => {
    const changed = content(MARKERS.replace("our line", "our line edited"));
    // The choice was made against the original hunk — against the changed one
    // it must not assemble a merge…
    expect(
      resolvedTextFor(changed, "a.txt", res({ choices: { [`a.txt::${cfIdx}`]: whole("ours") } })),
    ).toBeNull();
    // Line picks are bound the same way.
    expect(
      resolvedTextFor(changed, "a.txt", res({ choices: { [`a.txt::${cfIdx}`]: picks(["a:0"]) } })),
    ).toBeNull();
  });

  it("stageAllEligible needs one unstaged file that is fully decided", () => {
    const files = [textFile("a.txt"), textFile("b.txt")];
    const contentFor = (path: string) => (path === "a.txt" ? content(MARKERS) : undefined);
    expect(stageAllEligible(files, contentFor, res())).toBe(false);
    expect(
      stageAllEligible(files, contentFor, res({ choices: { [`a.txt::${cfIdx}`]: whole("ours") } })),
    ).toBe(true);
    // A staged file no longer counts, even though its choices would resolve it.
    expect(
      stageAllEligible([textFile("a.txt", true)], contentFor, res({ choices: { [`a.txt::${cfIdx}`]: whole("ours") } })),
    ).toBe(false);
  });

  it("stale cached text never qualifies a file reclassified binary/deleted", () => {
    // A refresh reclassified a.txt (kind changed) while decided text content
    // sits in the cache — it must not be eligible, or Stage all would git-add
    // stale text over the binary/deleted worktree state.
    const decided = { [`a.txt::${cfIdx}`]: whole("ours") };
    const contentFor = () => content("plain resolved\n");
    const binaryKind: OperationFile = { path: "a.txt", kind: "binary", deletedSide: "", resolved: false };
    const deletedKind: OperationFile = { path: "a.txt", kind: "deleted", deletedSide: "ours", resolved: false };
    expect(stageAllEligible([binaryKind], contentFor, res({ choices: decided }))).toBe(false);
    expect(stageAllEligible([deletedKind], contentFor, res({ choices: decided }))).toBe(false);
  });
});

describe("stagePlanFor (GL-180)", () => {
  const content = (text: string, binary = false) => ({ path: "a.txt", content: text, binary });
  const decided = { [`a.txt::${cfIdx}`]: whole("ours") };

  it("writes the validated merge for a decided text file", () => {
    expect(stagePlanFor(textFile("a.txt"), content(MARKERS), res({ choices: decided }))).toEqual({
      action: "write",
      text: "start\nour line\nend\n",
    });
  });

  it("stages a marker-free disk copy as-is (per-file Mark resolved parity)", () => {
    expect(stagePlanFor(textFile("a.txt"), content("resolved outside\n"), res({ choices: decided }))).toEqual(
      { action: "stageAsIs" },
    );
  });

  it("skips when the hunks changed on disk since the decision", () => {
    const changed = content(MARKERS.replace("our line", "our line edited"));
    expect(stagePlanFor(textFile("a.txt"), changed, res({ choices: decided }))).toEqual({
      action: "skip",
    });
  });

  it("skips reclassified, already-resolved, missing, and unreadable files", () => {
    const binaryKind: OperationFile = { path: "a.txt", kind: "binary", deletedSide: "", resolved: false };
    expect(stagePlanFor(binaryKind, content(MARKERS), res({ choices: decided })).action).toBe("skip");
    expect(stagePlanFor(textFile("a.txt", true), content(MARKERS), res({ choices: decided })).action).toBe("skip");
    expect(stagePlanFor(undefined, content(MARKERS), res({ choices: decided })).action).toBe("skip");
    expect(stagePlanFor(textFile("a.txt"), null, res({ choices: decided })).action).toBe("skip");
    expect(stagePlanFor(textFile("a.txt"), content("", true), res({ choices: decided })).action).toBe("skip");
  });
});

describe("fileResolutionState", () => {
  const loaded = { path: "a.txt", content: MARKERS, binary: false };

  it("reports an undecided text file as unresolved", () => {
    const s = fileResolutionState(textFile("a.txt"), loaded, regions, {});
    expect(s).toMatchObject({ totalHunks: 1, decided: 0, resolved: false, staged: false });
  });

  it("reports a fully decided file as resolved", () => {
    const s = fileResolutionState(textFile("a.txt"), loaded, regions, { [cfIdx]: whole("ours") });
    expect(s).toMatchObject({ decided: 1, resolved: true });
  });

  it("counts marker-free loaded content as resolved (stage as-is)", () => {
    const s = fileResolutionState(
      textFile("a.txt"),
      { path: "a.txt", content: "plain\n", binary: false },
      parseConflict("plain\n"),
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
    );
    expect(s).toMatchObject({ binary: true, wholeFile: true, noMarkers: false });
  });

  it("treats modify/delete conflicts as whole-file", () => {
    const deleted: OperationFile = { path: "gone.txt", kind: "deleted", deletedSide: "ours", resolved: false };
    expect(fileResolutionState(deleted, null, [], {})).toMatchObject({
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
    );
    expect(s.malformed).toBe(true);
    expect(s.resolved).toBe(false);
  });

  it("reports a staged file as resolved regardless of local choices", () => {
    const s = fileResolutionState(textFile("a.txt", true), loaded, regions, {});
    expect(s).toMatchObject({ staged: true, resolved: true });
  });

  it("treats a matching whole-file rewrite as fully resolved", () => {
    const s = fileResolutionState(textFile("a.txt"), loaded, regions, {}, true);
    expect(s).toMatchObject({ decided: 1, resolved: true });
  });
});

describe("custom resolutions in staging", () => {
  const text = ["ctx", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x", "end", ""].join("\n");
  const content = { path: "f.ts", content: text, binary: false };
  const regions = parseConflict(text);
  const print = hunkFingerprint(regions[1] as ConflictRegion);

  it("stages the custom text a rewritten hunk was resolved with", () => {
    expect(
      resolvedTextFor(content, "f.ts", res({ choices: { "f.ts::1": custom(["merged"], print) } })),
    ).toBe("ctx\nmerged\nend\n");
  });

  it("drops a custom resolution whose hunk changed on disk", () => {
    // Stale fingerprint → the choice no longer applies, so nothing is ready.
    expect(
      resolvedTextFor(content, "f.ts", res({ choices: { "f.ts::1": custom(["merged"], "stale") } })),
    ).toBeNull();
  });

  it("stages a whole-file rewrite that still matches the conflicted body", () => {
    expect(
      resolvedTextFor(content, "f.ts", res({ fileText: { "f.ts": { text: "rewritten\n", from: text } } })),
    ).toBe("rewritten\n");
    expect(
      resolvedTextFor(content, "f.ts", res({ fileText: {
        "f.ts": { text: "rewritten\n", from: "stale" },
      } })),
    ).toBeNull();
  });
});
