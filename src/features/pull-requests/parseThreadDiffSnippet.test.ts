import { describe, expect, it } from "vitest";
import { parseThreadDiffSnippet } from "./parseThreadDiffSnippet";

describe("parseThreadDiffSnippet", () => {
  it("classifies a header line", () => {
    expect(parseThreadDiffSnippet("@@ -1,2 +1,3 @@")).toEqual([
      { kind: "header", text: "@@ -1,2 +1,3 @@" },
    ]);
  });

  it("classifies an added line", () => {
    expect(parseThreadDiffSnippet("+new")).toEqual([{ kind: "add", text: "new" }]);
  });

  it("classifies a deleted line", () => {
    expect(parseThreadDiffSnippet("-old")).toEqual([{ kind: "del", text: "old" }]);
  });

  it("classifies a context line", () => {
    expect(parseThreadDiffSnippet(" keep")).toEqual([{ kind: "ctx", text: "keep" }]);
  });

  it("returns no lines for empty input", () => {
    expect(parseThreadDiffSnippet("")).toEqual([]);
    expect(parseThreadDiffSnippet(null)).toEqual([]);
    expect(parseThreadDiffSnippet(undefined)).toEqual([]);
  });

  it("returns no lines for unparseable input", () => {
    expect(parseThreadDiffSnippet("not a diff")).toEqual([]);
    expect(parseThreadDiffSnippet("@@ -1 +1 @@\ngarbage")).toEqual([]);
  });

  it("parses a mixed GitHub hunk", () => {
    const hunk = ["@@ -1,3 +1,4 @@ fn main() {", "     let x = 1;", "-    let y = 2;", "+    let y = 3;", " }"].join(
      "\n",
    );
    expect(parseThreadDiffSnippet(hunk)).toEqual([
      { kind: "header", text: "@@ -1,3 +1,4 @@ fn main() {" },
      { kind: "ctx", text: "    let x = 1;" },
      { kind: "del", text: "    let y = 2;" },
      { kind: "add", text: "    let y = 3;" },
      { kind: "ctx", text: "}" },
    ]);
  });
});
