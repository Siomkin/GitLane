import { describe, it, expect } from "vitest";
import { mergeWasAlreadyUpToDate } from "./mergeOutcome";

describe("mergeWasAlreadyUpToDate", () => {
  it("matches git's up-to-date no-op output", () => {
    expect(mergeWasAlreadyUpToDate("Already up to date.")).toBe(true);
  });

  it("matches the pre-2.17 hyphenated spelling", () => {
    expect(mergeWasAlreadyUpToDate("Already up-to-date.")).toBe(true);
  });

  it("matches the phrase surrounded by other output lines", () => {
    // Matching is deliberately line-by-line: hooks or git hints may precede the
    // phrase in the combined stdout/stderr, and must not hide the no-op.
    expect(
      mergeWasAlreadyUpToDate("hint: some advice from a future git\nAlready up to date."),
    ).toBe(true);
  });

  it("does not match a merge that created a commit", () => {
    expect(
      mergeWasAlreadyUpToDate(
        "Merge made by the 'ort' strategy.\n file.txt | 1 +\n 1 file changed, 1 insertion(+)",
      ),
    ).toBe(false);
  });

  it("does not match the phrase embedded in a diffstat path", () => {
    // A file literally named "Already up to date.txt" must not flip the toast.
    expect(mergeWasAlreadyUpToDate(" Already up to date.txt | 2 ++")).toBe(false);
  });
});
