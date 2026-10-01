import { describe, expect, it } from "vitest";
import { splitLinesCapped, utf8Bytes } from "./format";

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8Bytes("abc")).toBe(3);
    // "é" is 2 UTF-8 bytes; "😀" is 4 — a plain .length would under/over-count.
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("splitLinesCapped", () => {
  it("returns every line and the true total when under the cap", () => {
    expect(splitLinesCapped("a\nb\nc", 10)).toEqual({ lines: ["a", "b", "c"], total: 3 });
    expect(splitLinesCapped("", 10)).toEqual({ lines: [""], total: 1 });
  });

  it("caps the materialized lines but still counts the true total", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const { lines, total } = splitLinesCapped(text, 50);
    expect(total).toBe(1000);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("line 0");
    expect(lines[49]).toBe("line 49");
  });
});
