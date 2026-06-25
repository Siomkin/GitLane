import { describe, expect, it } from "vitest";
import {
  buildLineEditor,
  buildResolved,
  conflictRegionCount,
  decidedCount,
  deriveSelection,
  effectiveDecision,
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
