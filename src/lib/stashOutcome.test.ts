import { describe, expect, it } from "vitest";

import { stashWasRoutine } from "./stashOutcome";

describe("stashWasRoutine", () => {
  it("treats the plain backend success as routine", () => {
    expect(stashWasRoutine("Stashed your changes.")).toBe(true);
  });

  it("keeps a dotted path label routine", () => {
    expect(stashWasRoutine("Stashed src/a.ts.")).toBe(true);
  });

  it("is not routine when a second sentence carries recovery detail", () => {
    expect(
      stashWasRoutine(
        "Stashed your changes. Git could not remove every untracked path and stopped before clearing the working tree, so GitLane finished it. Git reported: warning: failed to remove blocked/.",
      ),
    ).toBe(false);
  });

  it("is not routine when partial cleanup is appended after a dotted label", () => {
    expect(
      stashWasRoutine(
        "Stashed foo.txt. Git's cleanup also removed empty untracked directory GitLane could not recreate: tmp. They held no files, so nothing was lost but the folders themselves.",
      ),
    ).toBe(false);
  });

  it("is not routine for an unrecognised outcome", () => {
    expect(stashWasRoutine("Nothing to stash")).toBe(false);
  });
});
