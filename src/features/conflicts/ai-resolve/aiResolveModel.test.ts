import { describe, expect, it } from "vitest";
import { buildResolvePrompt, extractResolvedContent } from "./aiResolveModel";

describe("buildResolvePrompt", () => {
  it("carries the path, the conflicted body, and the user's note", () => {
    const prompt = buildResolvePrompt({
      path: "src/a.ts",
      content: "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n",
      note: "  keep our logging  ",
    });
    expect(prompt).toContain("`src/a.ts`");
    expect(prompt).toContain("The user says: keep our logging");
    expect(prompt).toContain("<<<<<<< HEAD");
  });

  it("forbids the agent from touching the worktree itself", () => {
    const prompt = buildResolvePrompt({ path: "a.ts", content: "x", note: "" });
    expect(prompt).toContain("Do NOT edit, create, or delete any file");
    expect(prompt).toContain("GitLane performs the write itself");
  });

  it("omits the note line when the user said nothing", () => {
    const prompt = buildResolvePrompt({ path: "a.ts", content: "x", note: "   " });
    expect(prompt).not.toContain("The user says:");
  });
});

describe("extractResolvedContent", () => {
  it("unwraps a fenced block", () => {
    expect(extractResolvedContent("Here you go:\n```ts\nconst a = 1;\n```\n")).toEqual({
      text: "const a = 1;\n",
    });
  });

  it("keeps a file's own inner fences when unwrapping", () => {
    // The Rust side already strips one outer fence, so a Markdown file arrives
    // with its own ``` blocks intact — a lazy match would keep only the first.
    const file = "# Title\n\n```sh\nls\n```\n\nDone.\n";
    expect(extractResolvedContent("```markdown\n" + file + "```")).toEqual({ text: file });
  });

  it("drops a line of prose before the fence", () => {
    expect(extractResolvedContent("Sure — here it is:\n```\nconst a = 1;\n```")).toEqual({
      text: "const a = 1;\n",
    });
  });

  it("accepts a bare answer", () => {
    expect(extractResolvedContent("const a = 1;")).toEqual({ text: "const a = 1;\n" });
  });

  it("refuses an answer that still holds conflict markers", () => {
    const out = extractResolvedContent("```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n```");
    expect(out).toEqual({ error: expect.stringContaining("conflict markers") });
  });

  it("accepts a Markdown setext heading underline", () => {
    const out = extractResolvedContent("Title\n=======\n\nbody");
    expect(out).toEqual({ text: "Title\n=======\n\nbody\n" });
  });

  it("refuses an empty answer", () => {
    expect(extractResolvedContent("   ")).toEqual({ error: expect.any(String) });
  });

  it("does not treat a Markdown file's own inner fence as the whole file", () => {
    const file = "# Title\n\n```sh\nls\n```\n\nDone.\n";
    expect(extractResolvedContent(file)).toEqual({ text: file });
  });

  it("keeps a bare Markdown file that ends on a fence line", () => {
    // A search-from-anywhere unwrap would drop "# Title" and keep only `ls`.
    const file = "# Title\n\n```sh\nls\n```";
    expect(extractResolvedContent(file)).toEqual({ text: file + "\n" });
  });
});
