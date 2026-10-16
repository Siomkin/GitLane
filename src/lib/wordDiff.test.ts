import { describe, expect, it } from "vitest";
import { wordDiff, type CharRange } from "./wordDiff";

const pick = (text: string, ranges: CharRange[]) => ranges.map(([s, e]) => text.slice(s, e));

describe("wordDiff", () => {
  it("marks only the added word when one is appended", () => {
    const result = wordDiff("line 2", "line 2 changed");
    expect(pick("line 2", result!.a)).toEqual([]);
    expect(pick("line 2 changed", result!.b)).toEqual(["changed"]);
  });

  it("marks the replaced operator on both sides", () => {
    const result = wordDiff("return a + b", "return a - b");
    expect(pick("return a + b", result!.a)).toEqual(["+"]);
    expect(pick("return a - b", result!.b)).toEqual(["-"]);
  });

  it("marks each changed word separately around kept punctuation", () => {
    const result = wordDiff("const x = foo(bar)", "const x = baz(qux)");
    expect(pick("const x = baz(qux)", result!.b)).toEqual(["baz", "qux"]);
  });

  it("skips a rewrite that shares no word", () => {
    expect(wordDiff("line 15", "something else")).toBeNull();
  });

  it("skips identical and overly long lines", () => {
    expect(wordDiff("same", "same")).toBeNull();
    const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
    expect(wordDiff(long, `${long} x`)).toBeNull();
  });
});
