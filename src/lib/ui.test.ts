import { describe, expect, it } from "vitest";
import { commitNodeIdentity, personVisual } from "./commitAgents";
import { uiAuthor } from "./prs";
import { initials } from "./ui";

describe("initials", () => {
  it("takes the first letter of the first and last words, uppercased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada lovelace")).toBe("AL");
    expect(initials("Ada Byron Lovelace")).toBe("AL");
    expect(initials("john.doe")).toBe("JD");
  });

  it("yields a single letter for one-word names", () => {
    expect(initials("ada")).toBe("A");
  });

  it("returns the fallback for blank names", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ", "")).toBe("");
    expect(initials("", "GH")).toBe("GH");
  });

  it("collapses repeated and mixed whitespace between words", () => {
    expect(initials("  ada   \t lovelace  ")).toBe("AL");
    expect(initials("  ada  ")).toBe("A");
  });

  it("uppercases non-ASCII letters (BMP)", () => {
    expect(initials("éva łukasz")).toBe("ÉŁ");
    expect(initials("юрий гагарин")).toBe("ЮГ");
  });
});

describe("one author, one avatar", () => {
  it("renders identical initials in the graph, the inspector and the PR views", () => {
    for (const name of ["Jean Paul Sartre", "john.doe", "Linus"]) {
      const graph = commitNodeIdentity({ authorName: name, authorEmail: "a@b.c", body: "" });
      const inspector = personVisual({ name, email: "a@b.c" }, {}).initials;
      const pr = uiAuthor({ login: "someone", name }).initials;
      expect(graph).toMatchObject({ kind: "human", initials: inspector });
      expect(pr).toBe(inspector);
    }
  });
});
