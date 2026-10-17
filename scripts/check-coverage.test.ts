// The coverage ratchet's rules: a drop fails, an improvement is reported (and
// recorded only by an explicit update), a new file must meet the floor, and
// exempt paths are never scored.

import { describe, expect, it } from "vitest";

import { FLOOR, compare, lineCoverage } from "./check-coverage.mjs";

const summary = (entries: Record<string, number>) =>
  Object.fromEntries([
    ["total", { lines: { pct: 0 } }],
    ...Object.entries(entries).map(([file, pct]) => [`/repo/${file}`, { lines: { pct } }]),
  ]);

describe("lineCoverage", () => {
  it("keys by repo-relative path and rounds to one decimal", () => {
    expect(lineCoverage(summary({ "src/a.ts": 66.666 }), "/repo")).toEqual({ "src/a.ts": 66.7 });
  });

  it("ignores exempt paths and the total row", () => {
    const got = lineCoverage(summary({ "src/components/ui/icons.tsx": 0, "src/b.ts": 90 }), "/repo");

    expect(got).toEqual({ "src/b.ts": 90 });
  });
});

describe("compare", () => {
  it("fails a drop below the baseline", () => {
    expect(compare({ "src/a.ts": 70 }, { "src/a.ts": 71 }).regressed).toEqual([["src/a.ts", 70, 71]]);
  });

  it("reports an improvement without failing it", () => {
    const result = compare({ "src/a.ts": 80 }, { "src/a.ts": 71 });

    expect(result.improved).toEqual([["src/a.ts", 80, 71]]);
    expect(result.regressed).toEqual([]);
  });

  it("holds a new file to the floor", () => {
    const result = compare({ "src/new.ts": FLOOR - 1, "src/ok.ts": FLOOR }, {});

    expect(result.belowFloor).toEqual([["src/new.ts", FLOOR - 1]]);
  });

  it("lets a known low file stay where it is", () => {
    expect(compare({ "src/old.ts": 10 }, { "src/old.ts": 10 })).toEqual({
      regressed: [],
      belowFloor: [],
      improved: [],
    });
  });
});
