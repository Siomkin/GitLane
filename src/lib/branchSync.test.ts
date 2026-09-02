import { describe, expect, it } from "vitest";
import type { BranchInfo, BranchSyncState, RepoSummary } from "./api";
import { currentBranchSyncView, defaultPublishTarget, syncBadgeLabel, syncTitle } from "./branchSync";

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
  remote: null,
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

  it("enables push for ahead and unknown upstream states", () => {
    const view = currentBranchSyncView(summary, [branch(sync({ status: "ahead", ahead: 1 }))]);
    expect(view).toMatchObject({ label: "↑1", canPull: true, canPush: true, needsPublishPrompt: false });
    expect(currentBranchSyncView(summary, [branch(sync({ status: "unknown" }))])).toMatchObject({
      label: null,
      canPull: true,
      canPush: true,
      needsPublishPrompt: false,
    });
  });

  it("disables pull and push for a diverged branch but offers leased force-push", () => {
    // `git pull --ff-only` and a plain `git push` both fail on a diverged branch.
    // The badge still shows the spread; force-push is the toolbar's way out.
    expect(
      currentBranchSyncView(summary, [branch(sync({ status: "diverged", ahead: 1, behind: 1 }))]),
    ).toMatchObject({
      label: "↑1 ↓1",
      canPull: false,
      canPush: false,
      canForcePush: true,
      needsPublishPrompt: false,
    });
  });

  it("does not offer force-push for ahead, behind, or unpublished branches", () => {
    expect(currentBranchSyncView(summary, [branch(sync({ status: "ahead", ahead: 1 }))]).canForcePush).toBe(false);
    expect(currentBranchSyncView(summary, [branch(sync({ status: "behind", behind: 2 }))]).canForcePush).toBe(false);
    expect(
      currentBranchSyncView(summary, [branch(sync({ status: "noUpstream", upstream: null }))]).canForcePush,
    ).toBe(false);
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
      label: "stale",
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
    // A stale upstream gets a visible badge (it's an actionable warning), unlike
    // the quiet no-upstream / no-remote states which stay badge-less.
    expect(syncBadgeLabel(state)).toBe("stale");
    expect(syncBadgeLabel(sync({ status: "noUpstream", upstream: null }))).toBeNull();
    expect(syncBadgeLabel(sync({ status: "diverged", ahead: 3, behind: 2 }))).toBe("↑3 ↓2");
    expect(syncTitle(state)).toContain("origin/deleted");
  });
});

describe("branch sync view — unborn branch (GL-115 follow-up)", () => {
  // The backend now resolves the unborn branch name from HEAD's symbolic target,
  // so headBranch is populated *and* unborn is true. The view must treat it as a
  // checked-out branch (not "No branch is checked out.") while offering no sync.
  const unborn: RepoSummary = { ...summary, headBranch: "master", unborn: true, headOid: null };

  it("reads as a real branch with nothing to sync, not 'No branch'", () => {
    const view = currentBranchSyncView(unborn, []);
    expect(view).toMatchObject({ label: null, canPull: false, canPush: false, needsPublishPrompt: false });
    expect(view.title).toMatch(/no commits yet/i);
    expect(view.title).not.toMatch(/No branch is checked out/i);
  });

  it("wins over the 'sync unavailable' fallback even though it never appears in the branch list", () => {
    // Without the unborn guard this would hit `branches.find(...) === undefined`
    // and wrongly enable pull/push (see the "does not strand toolbar actions" case).
    const view = currentBranchSyncView(unborn, [branch(sync({ status: "upToDate" }))]);
    expect(view.canPull).toBe(false);
    expect(view.canPush).toBe(false);
  });

  it("stays distinct from a genuinely null branch and from detached HEAD", () => {
    expect(currentBranchSyncView({ ...summary, headBranch: null }, []).title).toBe(
      "No branch is checked out.",
    );
    expect(
      currentBranchSyncView({ ...summary, headBranch: null, detached: true }, []).title,
    ).toMatch(/Detached HEAD/);
  });
});

describe("defaultPublishTarget", () => {
  const remote = (name: string): BranchInfo => ({
    name,
    kind: "remote",
    target: "c1",
    isHead: false,
    upstream: null,
    remote: name.split("/")[0],
  });

  it("prefers the configured upstream when present", () => {
    expect(defaultPublishTarget([remote("upstream/main")], "main", "upstream/main")).toBe(
      "upstream/main",
    );
  });

  it("prefers origin over other remotes when no upstream is set", () => {
    const branches = [remote("fork/main"), remote("origin/main")];
    expect(defaultPublishTarget(branches, "feature")).toBe("origin/feature");
  });

  it("falls back to the first remote, then origin, when origin is absent", () => {
    expect(defaultPublishTarget([remote("fork/main")], "feature")).toBe("fork/feature");
    expect(defaultPublishTarget([], "feature")).toBe("origin/feature");
  });

  it("re-targets a stale upstream to the local branch name, keeping its remote", () => {
    // The pruned ref name (origin/deleted) must not be re-published; keep `origin`.
    expect(defaultPublishTarget([], "main", "origin/deleted", false)).toBe("origin/main");
    // Multi-remote: keep the configured (non-origin) remote rather than forcing origin.
    expect(
      defaultPublishTarget([remote("origin/x"), remote("fork/y")], "feature", "fork/old", false),
    ).toBe("fork/feature");
    // A bare local-tracking upstream (no slash) has no remote to keep — derive one.
    expect(defaultPublishTarget([remote("origin/x")], "feature", "trunk", false)).toBe(
      "origin/feature",
    );
  });
});
