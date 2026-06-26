import { describe, expect, it } from "vitest";
import type { BranchInfo, BranchSyncState, RepoSummary } from "./api";
import { currentBranchSyncView, syncBadgeLabel, syncTitle } from "./branchSync";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc123",
  detached: false,
};

const sync = (over: Partial<BranchSyncState>): BranchSyncState => ({
  status: "upToDate",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});

const branch = (state: BranchSyncState): BranchInfo => ({
  name: "main",
  kind: "local",
  target: "abc123",
  isHead: true,
  upstream: state.upstream,
  sync: state,
});

describe("branch sync view model", () => {
  it("keeps pull available for any branch with a usable upstream", () => {
    expect(currentBranchSyncView(summary, [branch(sync({ status: "upToDate" }))])).toMatchObject({
      label: null,
      canPull: true,
      canPush: false,
    });
    expect(currentBranchSyncView(summary, [branch(sync({ status: "ahead", ahead: 1 }))])).toMatchObject({
      label: "↑1",
      canPull: true,
      canPush: true,
    });
    const view = currentBranchSyncView(summary, [branch(sync({ status: "behind", behind: 2 }))]);
    expect(view).toMatchObject({ label: "↓2", canPull: true, canPush: false });
  });

  it("enables push for ahead, diverged, and unknown upstream states", () => {
    const view = currentBranchSyncView(summary, [branch(sync({ status: "ahead", ahead: 1 }))]);
    expect(view).toMatchObject({ label: "↑1", canPull: true, canPush: true, needsPublishPrompt: false });
    expect(
      currentBranchSyncView(summary, [branch(sync({ status: "diverged", ahead: 1, behind: 1 }))]),
    ).toMatchObject({ label: "↑1 ↓1", canPull: true, canPush: true, needsPublishPrompt: false });
    expect(currentBranchSyncView(summary, [branch(sync({ status: "unknown" }))])).toMatchObject({
      label: null,
      canPull: true,
      canPush: true,
      needsPublishPrompt: false,
    });
  });

  it("keeps detached and no-remote branches disabled", () => {
    expect(currentBranchSyncView({ ...summary, detached: true, headBranch: null }, [])).toMatchObject({
      label: null,
      canPull: false,
      canPush: false,
    });
    expect(currentBranchSyncView(summary, [branch(sync({ status: "noRemote", upstream: null }))])).toMatchObject({
      label: null,
      canPull: false,
      canPush: false,
    });
  });

  it("allows no-upstream and stale-upstream pushes through the publish prompt path", () => {
    expect(currentBranchSyncView(summary, [branch(sync({ status: "noUpstream", upstream: null }))])).toMatchObject({
      label: null,
      canPull: false,
      canPush: true,
      needsPublishPrompt: true,
    });
    expect(currentBranchSyncView(summary, [branch(sync({ status: "staleUpstream" }))])).toMatchObject({
      label: null,
      canPull: false,
      canPush: true,
      needsPublishPrompt: true,
    });
  });

  it("does not strand toolbar actions when the branch list is missing the current branch", () => {
    expect(currentBranchSyncView(summary, [])).toMatchObject({
      label: null,
      canPull: true,
      canPush: true,
    });
  });

  it("describes stale upstreams and compact branch-row badges", () => {
    const state = sync({ status: "staleUpstream", upstream: "origin/deleted" });
    expect(syncBadgeLabel(state)).toBeNull();
    expect(syncBadgeLabel(sync({ status: "diverged", ahead: 3, behind: 2 }))).toBe("↑3 ↓2");
    expect(syncTitle(state)).toContain("origin/deleted");
  });
});
