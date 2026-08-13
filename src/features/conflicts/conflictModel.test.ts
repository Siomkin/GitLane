import { describe, expect, it } from "vitest";
import {
  buildLineEditor,
  buildResolved,
  conflictRegionCount,
  decidedCount,
  deriveSelection,
  effectiveDecision,
  endsWithNewline,
  hasMalformedHunk,
  hunkFingerprint,
  isResolved,
  parseConflict,
  tokenize,
  type ConflictRegion,
  type Region,
} from "./conflictModel";

const TWO_WAY = [
  "function greet() {",
  "<<<<<<< HEAD",
  '  return "ours";',
  "=======",
  '  return "theirs";',
  ">>>>>>> feature",
  "}",
  "",
].join("\n");

const DIFF3 = [
  "<<<<<<< HEAD",
  "a-ours",
  "||||||| base",
  "a-base",
  "=======",
  "a-theirs",
  ">>>>>>> feature",
].join("\n");

describe("parseConflict", () => {
  it("splits context and a 2-way conflict hunk", () => {
    const regions = parseConflict(TWO_WAY);
    expect(regions.map((r) => r.kind)).toEqual(["ctx", "cf", "ctx"]);
    const cf = regions[1] as Extract<Region, { kind: "cf" }>;
    expect(cf.ours).toEqual(['  return "ours";']);
    expect(cf.theirs).toEqual(['  return "theirs";']);
    expect(cf.base).toBeNull();
    expect((regions[0] as Extract<Region, { kind: "ctx" }>).lines).toEqual(["function greet() {"]);
    expect((regions[2] as Extract<Region, { kind: "ctx" }>).lines).toEqual(["}"]);
  });

  it("captures the diff3 base section", () => {
    const regions = parseConflict(DIFF3);
    const cf = regions[0] as Extract<Region, { kind: "cf" }>;
    expect(cf.ours).toEqual(["a-ours"]);
    expect(cf.base).toEqual(["a-base"]);
    expect(cf.theirs).toEqual(["a-theirs"]);
  });

  it("returns a single context region for a marker-free file", () => {
    const regions = parseConflict("line a\nline b\n");
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("ctx");
  });

  it("does not emit a phantom trailing empty line", () => {
    const regions = parseConflict("a\nb\n");
    expect((regions[0] as Extract<Region, { kind: "ctx" }>).lines).toEqual(["a", "b"]);
  });
});

describe("parseConflict edge cases", () => {
  type Cf = Extract<Region, { kind: "cf" }>;

  it("tolerates a hunk with no closing >>>>>>> marker", () => {
    const regions = parseConflict("<<<<<<< HEAD\nours\n=======\ntheirs");
    const cf = regions.find((r): r is Cf => r.kind === "cf")!;
    expect(cf.ours).toEqual(["ours"]);
    expect(cf.theirs).toEqual(["theirs"]);
  });

  it("parses two consecutive conflict hunks", () => {
    const src = [
      "<<<<<<< HEAD",
      "a-ours",
      "=======",
      "a-theirs",
      ">>>>>>> x",
      "<<<<<<< HEAD",
      "b-ours",
      "=======",
      "b-theirs",
      ">>>>>>> x",
    ].join("\n");
    const regions = parseConflict(src);
    expect(regions.map((r) => r.kind)).toEqual(["cf", "cf"]);
    expect(conflictRegionCount(regions)).toBe(2);
  });

  it("handles an empty ours side", () => {
    const regions = parseConflict("<<<<<<< HEAD\n=======\nonly-theirs\n>>>>>>> x");
    const cf = regions[0] as Cf;
    expect(cf.ours).toEqual([]);
    expect(cf.theirs).toEqual(["only-theirs"]);
  });

  it("treats an indented marker-like line as content, not a structural marker", () => {
    // Markers are only recognised at column 0 (startsWith), so a line that merely
    // contains "=======" stays content and never splits a hunk.
    const regions = parseConflict("before\n  ======= not a real marker\nafter");
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe("ctx");
  });

  it("still detects markers when lines end with CR (CRLF files)", () => {
    const src = "ctx\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> x\r\n";
    expect(conflictRegionCount(parseConflict(src))).toBe(1);
  });
});

describe("counts", () => {
  const regions = parseConflict(TWO_WAY);

  it("counts conflict hunks", () => {
    expect(conflictRegionCount(regions)).toBe(1);
  });

  it("tracks decided hunks and resolution", () => {
    expect(decidedCount(regions, {})).toBe(0);
    expect(isResolved(regions, {})).toBe(false);
    expect(isResolved(regions, { 1: "ours" })).toBe(true);
    expect(decidedCount(regions, { 1: "ours" })).toBe(1);
  });
});

describe("buildResolved", () => {
  const regions = parseConflict(TWO_WAY);

  it("emits ours", () => {
    expect(buildResolved(regions, { 1: "ours" }, {})).toBe(
      'function greet() {\n  return "ours";\n}\n',
    );
  });

  it("emits theirs", () => {
    expect(buildResolved(regions, { 1: "theirs" }, {})).toBe(
      'function greet() {\n  return "theirs";\n}\n',
    );
  });

  it("emits both sides in order", () => {
    expect(buildResolved(regions, { 1: "both" }, {})).toBe(
      'function greet() {\n  return "ours";\n  return "theirs";\n}\n',
    );
  });

  it("emits only the selected lines in line mode", () => {
    const sel = { 1: new Set(["b:0"]) };
    expect(buildResolved(regions, { 1: "lines" }, sel)).toBe(
      'function greet() {\n  return "theirs";\n}\n',
    );
  });

  it("returns an empty string when the resolution contributes no lines", () => {
    // Accepting an empty side for a whole-file conflict is a genuinely empty
    // file — not the lone "\n" that join+append would otherwise produce.
    const rgs = parseConflict("<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> x\n");
    expect(buildResolved(rgs, { 0: "ours" }, {})).toBe("");
  });

  it("preserves a file that had no trailing newline", () => {
    // The conflicted source ended without a final newline; resolving it must not
    // silently add one (that would be a content change beyond the resolution).
    const src = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x\nb";
    expect(endsWithNewline(src)).toBe(false);
    const rgs = parseConflict(src);
    expect(buildResolved(rgs, { 1: "ours" }, {}, endsWithNewline(src))).toBe("a\nours\nb");
  });

  it("keeps the trailing newline when the source had one", () => {
    const src = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> x\nb\n";
    expect(endsWithNewline(src)).toBe(true);
    const rgs = parseConflict(src);
    expect(buildResolved(rgs, { 1: "ours" }, {}, endsWithNewline(src))).toBe("a\nours\nb\n");
  });
});

describe("malformed markers", () => {
  it("flags a hunk missing its ======= split", () => {
    const rgs = parseConflict("<<<<<<< HEAD\nours\nno-split-or-close");
    expect(hasMalformedHunk(rgs)).toBe(true);
    // Even if every hunk looks "decided", a malformed file must never stage.
    expect(isResolved(rgs, { 0: "ours" })).toBe(false);
  });

  it("flags a hunk missing its >>>>>>> close", () => {
    const rgs = parseConflict("<<<<<<< HEAD\nours\n=======\ntheirs");
    expect(hasMalformedHunk(rgs)).toBe(true);
    expect(isResolved(rgs, { 0: "theirs" })).toBe(false);
  });

  it("does not flag a well-formed hunk", () => {
    expect(hasMalformedHunk(parseConflict(TWO_WAY))).toBe(false);
  });
});

describe("effectiveDecision", () => {
  it("prefers a non-empty line selection over the whole-hunk decision", () => {
    expect(effectiveDecision("ours", new Set(["b:0"]))).toBe("lines");
    expect(effectiveDecision("ours", new Set())).toBe("ours");
    expect(effectiveDecision(undefined, undefined)).toBeUndefined();
  });
});

describe("deriveSelection", () => {
  const region = parseConflict(TWO_WAY).find((r): r is ConflictRegion => r.kind === "cf")!;

  it("seeds all ours/theirs/both lines from a whole-hunk decision", () => {
    expect([...deriveSelection(region, "ours")]).toEqual(["a:0"]);
    expect([...deriveSelection(region, "theirs")]).toEqual(["b:0"]);
    expect([...deriveSelection(region, "both")].sort()).toEqual(["a:0", "b:0"]);
    expect(deriveSelection(region, undefined).size).toBe(0);
  });
});

describe("decidedCount with line selections", () => {
  const regions = parseConflict(TWO_WAY);
  it("counts a hunk with any picked line as decided", () => {
    expect(decidedCount(regions, {}, { 1: new Set(["a:0"]) })).toBe(1);
    expect(isResolved(regions, {}, { 1: new Set(["b:0"]) })).toBe(true);
    expect(decidedCount(regions, {}, { 1: new Set() })).toBe(0);
  });
});

describe("buildLineEditor", () => {
  const regions = parseConflict(TWO_WAY);
  const noneSelected = () => new Set<string>();

  it("emits A/B pane rows with context + conflict lines and a placeholder output", () => {
    const ed = buildLineEditor(regions, noneSelected);
    // ours pane: context "function greet() {", conflict line, context "}".
    expect(ed.aRows.map((r) => r.conflict)).toEqual([false, true, false]);
    expect(ed.bRows.find((r) => r.conflict)?.tokens.map((t) => t.v).join("")).toContain("theirs");
    // No picks yet → the output shows a single placeholder for the one conflict.
    const placeholders = ed.outRows.filter((r) => r.kind === "placeholder");
    expect(placeholders).toHaveLength(1);
    expect(ed.aAll).toBe(false);
  });

  it("reflects a line selection as picked rows and a removable output line", () => {
    const ed = buildLineEditor(regions, (idx) => (idx === 1 ? new Set(["b:0"]) : new Set()));
    expect(ed.bRows.find((r) => r.conflict)?.picked).toBe(true);
    expect(ed.bAll).toBe(true);
    const outLine = ed.outRows.find((r) => r.kind === "line" && r.removable);
    expect(outLine).toBeTruthy();
  });
});

describe("tokenize", () => {
  it("classifies keywords, strings and identifiers", () => {
    const tokens = tokenize('const x = "hi";');
    expect(tokens.map((t) => t.v).join("")).toBe('const x = "hi";');
    // keyword `const` gets the keyword class, string literal the string class.
    expect(tokens[0].cls).toContain("violet");
    expect(tokens.some((t) => t.cls.includes("amber"))).toBe(true);
  });

  it("never returns an empty token list", () => {
    expect(tokenize("")).toHaveLength(1);
  });
});

describe("hunkFingerprint (GL-180)", () => {
  const hunk = (ours: string[], theirs: string[], base: string[] | null = null): ConflictRegion => ({
    kind: "cf",
    ours,
    theirs,
    base,
    malformed: false,
  });

  it("is stable for identical sides and changes when either side changes", () => {
    const a = hunkFingerprint(hunk(["x"], ["y"]));
    expect(hunkFingerprint(hunk(["x"], ["y"]))).toBe(a);
    expect(hunkFingerprint(hunk(["x2"], ["y"]))).not.toBe(a);
    expect(hunkFingerprint(hunk(["x"], ["y2"]))).not.toBe(a);
  });

  it("distinguishes lines moving across the ours/theirs boundary", () => {
    expect(hunkFingerprint(hunk(["x", "y"], []))).not.toBe(hunkFingerprint(hunk(["x"], ["y"])));
  });

  it("ignores diff3 base lines (display-only, never part of the resolution)", () => {
    expect(hunkFingerprint(hunk(["x"], ["y"], ["old"]))).toBe(hunkFingerprint(hunk(["x"], ["y"])));
  });
});

describe("custom (rewritten) hunk resolutions", () => {
  const text = ["ctx", "<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> x", "end", ""].join("\n");
  const regions = parseConflict(text);

  it("builds the file from custom lines", () => {
    expect(buildResolved(regions, { 1: "custom" }, {}, true, { 1: ["merged"] })).toBe(
      "ctx\nmerged\nend\n",
    );
    // An empty custom resolution is a decision — it keeps nothing.
    expect(buildResolved(regions, { 1: "custom" }, {}, true, { 1: [] })).toBe("ctx\nend\n");
    expect(isResolved(regions, { 1: "custom" }, {})).toBe(true);
  });

  it("renders custom lines in the output pane, tagged as neither side", () => {
    const editor = buildLineEditor(regions, () => new Set<string>(), (idx) =>
      idx === 1 ? ["merged"] : undefined,
    );
    const custom = editor.outRows.filter((r) => r.kind === "line" && r.side === "ai");
    expect(custom).toHaveLength(1);
    // No leftover "pick lines above" placeholder — the hunk is decided.
    expect(editor.outRows.some((r) => r.kind === "placeholder" && !r.dropped)).toBe(false);
  });
});
