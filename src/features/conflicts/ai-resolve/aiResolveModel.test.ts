import { describe, expect, it } from "vitest";
import {
  MAX_SWEEP_BYTES,
  buildResolvePrompt,
  holdsSentinel,
  splitResolvedAnswer,
  sweepTooLarge,
} from "./aiResolveModel";

const conflict = "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n";
const block = (path: string, body: string) => `=== FILE: ${path} ===\n${body}=== END FILE ===\n`;

describe("buildResolvePrompt", () => {
  it("carries one file's path, conflicted body, and note", () => {
    const prompt = buildResolvePrompt([
      { path: "src/a.ts", content: conflict, note: "  keep our logging  " },
    ]);
    expect(prompt).toContain("`src/a.ts`");
    expect(prompt).toContain("The user says about `src/a.ts`: keep our logging");
    expect(prompt).toContain(block("src/a.ts", conflict));
  });

  it("carries every file of a sweep, each note beside its own file", () => {
    const prompt = buildResolvePrompt([
      { path: "a.ts", content: "x", note: "keep ours" },
      { path: "b.ts", content: "y", note: "" },
      { path: "c.md", content: "z\n", note: "   " },
    ]);
    expect(prompt).toContain("these 3 files");
    for (const path of ["a.ts", "b.ts", "c.md"]) expect(prompt).toContain(`=== FILE: ${path} ===`);
    expect(prompt).toContain("The user says about `a.ts`: keep ours");
    expect(prompt).not.toContain("The user says about `b.ts`");
    expect(prompt).not.toContain("The user says about `c.md`");
  });

  it("forbids the agent from touching the worktree itself", () => {
    const prompt = buildResolvePrompt([{ path: "a.ts", content: "x", note: "" }]);
    expect(prompt).toContain("Do NOT edit, create, or delete any file");
    expect(prompt).toContain("GitLane performs the write itself");
  });
});

describe("splitResolvedAnswer", () => {
  const sources = { "a.ts": conflict, "b.ts": conflict };

  it("matches blocks by path, not position", () => {
    const out = splitResolvedAnswer(block("b.ts", "bee\n") + block("a.ts", "ay\n"), sources);
    expect(out).toEqual({ "a.ts": { text: "ay\n" }, "b.ts": { text: "bee\n" } });
  });

  it("reports a requested file the agent did not return", () => {
    const out = splitResolvedAnswer(block("a.ts", "ay\n"), sources);
    expect(out["a.ts"]).toEqual({ text: "ay\n" });
    expect(out["b.ts"]).toEqual({ error: "The agent didn't return this file." });
  });

  it("fails only the block that still holds markers", () => {
    const out = splitResolvedAnswer(block("a.ts", "ay\n") + block("b.ts", conflict), sources);
    expect(out["a.ts"]).toEqual({ text: "ay\n" });
    expect(out["b.ts"]).toEqual({ error: expect.stringContaining("conflict markers") });
  });

  it("ignores a block for a path nobody asked for, and prose around blocks", () => {
    const answer = `Here you go:\n${block("evil.ts", "x\n")}${block("a.ts", "ay\n")}Done.\n`;
    const out = splitResolvedAnswer(answer, { "a.ts": conflict });
    expect(out).toEqual({ "a.ts": { text: "ay\n" } });
  });

  it("keeps a Markdown body's own fences intact", () => {
    const md = "# Title\n\n```sh\nls\n```\n\nDone.\n";
    const out = splitResolvedAnswer(block("README.md", md), { "README.md": conflict });
    expect(out["README.md"]).toEqual({ text: md });
  });

  it("unwraps a body the agent fenced anyway, unless the file itself starts with a fence", () => {
    expect(
      splitResolvedAnswer(block("a.ts", "```ts\nconst a = 1;\n```\n"), { "a.ts": conflict }),
    ).toEqual({ "a.ts": { text: "const a = 1;\n" } });
    const fencedFile = "```\nliteral\n```\n";
    expect(splitResolvedAnswer(block("a.md", fencedFile), { "a.md": fencedFile + conflict })).toEqual(
      { "a.md": { text: fencedFile } },
    );
  });

  it("discards a block whose end line is missing instead of merging the next file into it", () => {
    const answer = "=== FILE: a.ts ===\nay\n" + block("b.ts", "bee\n");
    const out = splitResolvedAnswer(answer, sources);
    expect(out["a.ts"]).toEqual({ error: "The agent didn't return this file." });
    expect(out["b.ts"]).toEqual({ text: "bee\n" });
  });

  it("keeps a resolved file's own outer fence when the conflict hid it on line 1", () => {
    // The source starts with markers, but one side opens with a fence.
    const source = "<<<<<<< HEAD\n```js\nours\n=======\n```js\ntheirs\n>>>>>>> x\n```\n";
    const resolved = "```js\nours\n```\n";
    expect(splitResolvedAnswer(block("a.md", resolved), { "a.md": source })).toEqual({
      "a.md": { text: resolved },
    });
  });

  it("keeps a body's trailing blank line", () => {
    expect(splitResolvedAnswer(block("a.ts", "x\n\n"), { "a.ts": conflict })).toEqual({
      "a.ts": { text: "x\n\n" },
    });
  });

  it("keeps CRLF line endings in a body", () => {
    const answer = "=== FILE: a.ts ===\r\nx\r\ny\r\n=== END FILE ===\r\n";
    expect(splitResolvedAnswer(answer, { "a.ts": conflict })).toEqual({
      "a.ts": { text: "x\r\ny\r\n" },
    });
  });

  it("takes a one-file answer without sentinels as that file, fenced or bare", () => {
    expect(
      splitResolvedAnswer("Sure — here it is:\n```ts\nconst a = 1;\n```\n", { "a.ts": conflict }),
    ).toEqual({ "a.ts": { text: "const a = 1;\n" } });
    expect(splitResolvedAnswer("const a = 1;", { "a.ts": conflict })).toEqual({
      "a.ts": { text: "const a = 1;\n" },
    });
    // Two files still need the sentinel format.
    expect(splitResolvedAnswer("const a = 1;", sources)["a.ts"]).toEqual({
      error: "The agent didn't return this file.",
    });
  });

  it("accepts a Markdown setext underline and refuses an empty body", () => {
    const out = splitResolvedAnswer(block("a.md", "Title\n=======\n") + block("b.ts", "\n"), {
      "a.md": conflict,
      "b.ts": conflict,
    });
    expect(out["a.md"]).toEqual({ text: "Title\n=======\n" });
    expect(out["b.ts"]).toEqual({ error: expect.any(String) });
  });

});

describe("holdsSentinel", () => {
  it("flags a file whose own content holds a sentinel line", () => {
    expect(holdsSentinel("x\n=== END FILE ===\n")).toBe(true);
    expect(holdsSentinel("=== FILE: y ===\n")).toBe(true);
    expect(holdsSentinel("x === END FILE === y\n" + conflict)).toBe(false);
  });
});

describe("sweepTooLarge", () => {
  it("allows a set at the budget and refuses one byte over", () => {
    const half = "x".repeat(MAX_SWEEP_BYTES / 2);
    expect(sweepTooLarge([half, half])).toBe(false);
    expect(sweepTooLarge([half, half, "y"])).toBe(true);
  });
});
