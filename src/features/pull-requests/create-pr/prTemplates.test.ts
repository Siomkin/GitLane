import { describe, expect, it } from "vitest";
import type { HistorySearchResult } from "@/lib/api";
import { bodyFromCommits, findPrTemplates } from "./prTemplates";

describe("findPrTemplates", () => {
  it("finds the repository default in any of the three directories, any casing", () => {
    expect(findPrTemplates([".github/PULL_REQUEST_TEMPLATE.md"])[0]).toEqual({
      path: ".github/PULL_REQUEST_TEMPLATE.md",
      file: "PULL_REQUEST_TEMPLATE.md",
      note: ".github/",
    });
    expect(findPrTemplates(["pull_request_template.md"])[0].note).toBe("repository root");
    expect(findPrTemplates(["docs/pull_request_template"])[0].note).toBe("docs/");
  });

  it("lists the multi-template directory in path order, after the default", () => {
    const found = findPrTemplates([
      ".github/PULL_REQUEST_TEMPLATE/feature.md",
      ".github/PULL_REQUEST_TEMPLATE/bugfix.md",
      ".github/pull_request_template.md",
    ]);
    expect(found.map((t) => t.file)).toEqual([
      "pull_request_template.md",
      "bugfix.md",
      "feature.md",
    ]);
    expect(found[1].note).toBe(".github/PULL_REQUEST_TEMPLATE/");
  });

  it("ignores files that merely look related", () => {
    expect(
      findPrTemplates([
        "src/pull_request_template.md",
        ".github/ISSUE_TEMPLATE/bug.md",
        ".github/pull_request_template.md.bak",
        "README.md",
      ]),
    ).toEqual([]);
  });
});

describe("bodyFromCommits", () => {
  const commit = (shortId: string, summary: string) =>
    ({ shortId, summary }) as HistorySearchResult;

  it("lists subjects in reading order — oldest first — with their short ids", () => {
    // The range read hands back newest-first; a description reads as a
    // sequence, so this reverses exactly once.
    const body = bodyFromCommits([commit("b2", "Second"), commit("a1", "First")]);
    expect(body).toBe("## Summary\n\n## Changes\n- First (a1)\n- Second (b2)\n\n## Testing\n");
  });

  it("still produces the skeleton when the range is empty", () => {
    expect(bodyFromCommits([])).toContain("## Summary");
  });
});
