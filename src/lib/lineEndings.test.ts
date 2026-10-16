import { describe, expect, it } from "vitest";
import { lineEndingOf, toLf, withLineEnding } from "./lineEndings";

describe("lineEndingOf", () => {
  it("classifies LF, CRLF and mixed text", () => {
    expect(lineEndingOf("a\nb\n")).toBe("lf");
    expect(lineEndingOf("")).toBe("lf");
    expect(lineEndingOf("a\r\nb\r\n")).toBe("crlf");
    expect(lineEndingOf("a\r\nb\n")).toBe("mixed");
    expect(lineEndingOf("a\rb\r\n")).toBe("mixed");
  });
});

describe("round trip", () => {
  it("restores a CRLF file byte for byte", () => {
    const text = "a\r\nb\r\nc";
    expect(withLineEnding(toLf(text), lineEndingOf(text))).toBe(text);
  });
  it("writes new lines typed into a CRLF file as CRLF", () => {
    expect(withLineEnding("a\nnew\nb\n", "crlf")).toBe("a\r\nnew\r\nb\r\n");
  });
  it("leaves LF text alone", () => {
    expect(withLineEnding("a\nb\n", "lf")).toBe("a\nb\n");
  });
});
