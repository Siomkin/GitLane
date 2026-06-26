import { describe, expect, it } from "vitest";
import type { ReflogEntry } from "@/lib/api";
import { recoveryBranchName, reflogLabel } from "./reflogViewModel";

const entry = (overrides: Partial<ReflogEntry>): ReflogEntry => ({
  oid: "abc123456789",
  shortOid: "abc1234",
  selector: "refs/heads/feature@{0}",
  shortSelector: "feature@{0}",
  refName: "feature",
  subject: "checkout: moving from main to feature",
  committerName: "T",
  committerEmail: "t@example.test",
  timestamp: 1,
  ...overrides,
});

describe("reflogViewModel", () => {
  it("prefers the readable short selector for labels", () => {
    expect(reflogLabel(entry({}))).toBe("feature@{0}");
  });

  it("builds a safe recovery branch name from the ref", () => {
    expect(recoveryBranchName(entry({ refName: "feature with spaces" }))).toBe(
      "recovery/feature-with-spaces",
    );
  });

  it("strips a leading dash that would make an invalid ref", () => {
    expect(recoveryBranchName(entry({ refName: "-oops" }))).toBe("recovery/oops");
  });

  it("falls back to the short oid when the ref sanitizes to empty", () => {
    expect(recoveryBranchName(entry({ refName: "---", shortOid: "abc1234" }))).toBe(
      "recovery/abc1234",
    );
  });
});
