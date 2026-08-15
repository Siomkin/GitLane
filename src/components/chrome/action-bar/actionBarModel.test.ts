// Focused tests for the toolbar's pure derivations (GL-182): branch label,
// current-branch PR badge match, transport-auth visibility, PR-forge gate.
import { describe, expect, it } from "vitest";

import { ForgeKind, type RemoteInfo, type RepoSummary } from "@/lib/api";
import type { PrSummary } from "@/lib/prs";
import { currentBranchLabel, findOpenPr, isPrForge, transportConfigured } from "./actionBarModel";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc1234def",
  detached: false,
};

const pr = (over: Partial<PrSummary>): PrSummary =>
  ({ num: 1, title: "t", state: "open", branch: "main", ...over }) as PrSummary;

describe("currentBranchLabel", () => {
  it("shows the branch name for a normal checkout", () => {
    expect(currentBranchLabel(SUMMARY)).toBe("main");
  });

  it("shows the short SHA for a detached HEAD", () => {
    expect(currentBranchLabel({ ...SUMMARY, headBranch: null, detached: true })).toBe(
      "detached @ abc1234",
    );
  });

  it("prefers the unborn placeholder over a resolved branch name (GL-115)", () => {
    expect(currentBranchLabel({ ...SUMMARY, headBranch: "master", unborn: true })).toBe(
      "No commits yet",
    );
  });

  it("falls back when there is no repo or branch", () => {
    expect(currentBranchLabel(null)).toBe("No branch");
    expect(currentBranchLabel({ ...SUMMARY, headBranch: null })).toBe("No branch");
  });
});

describe("findOpenPr", () => {
  it("matches an open PR whose head is the checked-out branch", () => {
    const open = pr({ num: 7 });
    expect(findOpenPr(SUMMARY, [pr({ num: 3, state: "closed" }), open])).toBe(open);
  });

  it("never matches for detached or unborn HEADs", () => {
    const prs = [pr({ branch: "main" })];
    expect(findOpenPr({ ...SUMMARY, detached: true }, prs)).toBeUndefined();
    expect(findOpenPr({ ...SUMMARY, unborn: true }, prs)).toBeUndefined();
    expect(findOpenPr(null, prs)).toBeUndefined();
  });
});

describe("transportConfigured", () => {
  const remote = (url: string, isDefault = true): RemoteInfo => ({
    name: "origin",
    fetchUrl: url,
    pushUrl: url,
    isDefault,
  });

  it("counts an SSH remote and an HTTPS username as visible auth", () => {
    expect(transportConfigured([remote("git@github.com:o/r.git")])).toBe(true);
    expect(transportConfigured([remote("https://alice@github.com/o/r.git")])).toBe(true);
  });

  it("does not count a bare HTTPS URL (a helper may work, but is unprovable)", () => {
    expect(transportConfigured([remote("https://github.com/o/r.git")])).toBe(false);
    expect(transportConfigured([])).toBe(false);
  });

  it("reads the default remote, falling back to the first", () => {
    expect(
      transportConfigured([
        remote("https://github.com/o/r.git", false),
        remote("git@github.com:o/r.git", true),
      ]),
    ).toBe(true);
  });
});

describe("isPrForge", () => {
  it("gates PR polling to GitHub, GitLab, and Bitbucket", () => {
    expect(isPrForge(ForgeKind.GitHub)).toBe(true);
    expect(isPrForge(ForgeKind.GitLab)).toBe(true);
    expect(isPrForge(ForgeKind.Bitbucket)).toBe(true);
    expect(isPrForge(ForgeKind.AzureDevOps)).toBe(false);
    expect(isPrForge(null)).toBe(false);
    expect(isPrForge(undefined)).toBe(false);
  });
});
