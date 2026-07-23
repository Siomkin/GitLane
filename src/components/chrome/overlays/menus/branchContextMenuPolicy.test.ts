import { describe, expect, it } from "vitest";
import { BranchKind, type BranchInfo, type RepoForge, type WorktreeInfo } from "@/lib/api";
import {
  deriveBranchContextMenuPolicy,
  MAIN_WORKTREE_DELETE_DISABLED_REASON,
} from "./branchContextMenuPolicy";

const githubForge: RepoForge = {
  hasRemote: true,
  kind: "github",
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};

const localBranch = (name: string, target = `${name}-oid`): BranchInfo => ({
  name,
  kind: BranchKind.Local,
  target,
  isHead: false,
  upstream: null,
  remote: null,
});

const remoteBranch = (
  name: string,
  remote = "origin",
  target = `${name}-oid`,
): BranchInfo => ({
  name,
  kind: BranchKind.Remote,
  target,
  isHead: false,
  upstream: null,
  remote,
});

const worktree = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  name: "repo",
  path: "/work/repo",
  branch: "main",
  isMain: true,
  ...over,
});

const derive = (
  over: Partial<Parameters<typeof deriveBranchContextMenuPolicy>[0]> = {},
) =>
  deriveBranchContextMenuPolicy({
    branch: "feature",
    isCurrent: false,
    currentBranch: "main",
    branches: [localBranch("main", "main-oid"), localBranch("feature", "feature-oid")],
    worktrees: [],
    workdir: "/work/repo",
    forge: null,
    ...over,
  });

describe("deriveBranchContextMenuPolicy", () => {
  it("derives unique local ref, publish, sync, and plain-delete policy", () => {
    const feature = {
      ...localBranch("feature", "1234567890"),
      upstream: "origin/feature",
      sync: { status: "staleUpstream" as const, upstream: "origin/feature", ahead: 3, behind: 2 },
    };

    const policy = derive({ branches: [localBranch("main", "main-oid"), feature] });

    expect(policy).toMatchObject({
      info: feature,
      tip: "1234567890",
      tipShort: "1234567",
      targetOid: "1234567890",
      currentOid: "main-oid",
      upstream: "origin/feature",
      needsPublishPrompt: true,
      isLocal: true,
      isRemote: false,
      aheadBehind: "↑3 ↓2",
      localDeleteMode: "branch",
    });
  });

  it.each(["noUpstream", "staleUpstream"] as const)(
    "requires the publish flow for %s sync state",
    (status) => {
      const policy = derive({
        branches: [
          localBranch("main", "main-oid"),
          {
            ...localBranch("feature", "feature-oid"),
            sync: { status, upstream: null, ahead: 0, behind: 0 },
          },
        ],
      });

      expect(policy.needsPublishPrompt).toBe(true);
    },
  );

  it("rejects integration when the live HEAD moves onto the menu branch", () => {
    const policy = derive({
      // The menu-opening snapshot still says non-current, but currentBranch is live.
      isCurrent: false,
      currentBranch: "feature",
    });

    expect(policy.targetOid).toBe("feature-oid");
    expect(policy.currentOid).toBe("feature-oid");
    expect(policy.canIntegrateIntoCurrent).toBe(false);
  });

  it("fails kind-, oid-, and danger-policy closed for an ambiguous display name", () => {
    const policy = derive({
      branch: "origin/feature",
      branches: [
        localBranch("main", "main-oid"),
        localBranch("origin/feature", "local-oid"),
        remoteBranch("origin/feature", "origin", "remote-oid"),
      ],
    });

    expect(policy).toMatchObject({
      info: undefined,
      tip: null,
      targetOid: null,
      isLocal: false,
      isRemote: false,
      localDeleteMode: "none",
      remoteDeleteTarget: null,
      // Checkout resolution intentionally remains independent of the ambiguous
      // kind/oid policy so the existing tracking checkout stays available.
      remoteCheckout: { remote: "origin", branch: "feature" },
    });
  });

  it("derives remote checkout and slash-containing remote deletion targets", () => {
    const policy = derive({
      branch: "team/tools/feature",
      branches: [
        localBranch("main", "main-oid"),
        localBranch("feature", "local-feature-oid"),
        remoteBranch("team/tools/feature", "team/tools", "remote-feature-oid"),
      ],
    });

    expect(policy).toMatchObject({
      isLocal: false,
      isRemote: true,
      remoteCheckout: { remote: "team/tools", branch: "feature" },
      remoteCheckoutHasLocal: true,
      localDeleteMode: "none",
      remoteDeleteTarget: { remote: "team/tools", branch: "feature" },
    });
  });

  it("allows handoff and combined deletion for a valid linked-worktree owner", () => {
    const worktrees = [
      worktree(),
      worktree({
        name: "repo-feature",
        path: "/work/repo-feature",
        branch: "feature",
        isMain: false,
      }),
    ];

    const policy = derive({ worktrees });

    expect(policy.existingWorktree?.path).toBe("/work/repo-feature");
    expect(policy.handoffHere?.value).toBe("/work/repo");
    expect(policy).toMatchObject({
      canHandOff: true,
      canRemoveWorktree: true,
      worktreeCheckedOut: true,
      worktreeRef: "feature-oid",
      localDeleteMode: "branch-and-worktree",
    });
  });

  it("blocks main-worktree deletion with the exact reason and rejects prunable handoff", () => {
    const policy = derive({
      workdir: "/work/current",
      worktrees: [
        worktree({ path: "/work/repo", branch: "feature", prunable: true }),
        worktree({ name: "current", path: "/work/current", branch: "main", isMain: false }),
      ],
    });

    expect(policy).toMatchObject({
      handoffHere: null,
      canHandOff: false,
      canRemoveWorktree: false,
      localDeleteMode: "blocked-main-worktree",
    });
    expect(MAIN_WORKTREE_DELETE_DISABLED_REASON).toBe("Checked out in the main worktree.");
  });

  describe("forge link", () => {
    const published = (over: Partial<BranchInfo> = {}): BranchInfo => ({
      ...localBranch("feature", "feature-oid"),
      upstream: "origin/feature",
      upstreamRemote: "origin",
      sync: { status: "upToDate" as const, upstream: "origin/feature", ahead: 0, behind: 0 },
      ...over,
    });

    it("links a published local branch to its UPSTREAM branch, not the local ref name", () => {
      // A local `feature` tracking `origin/main` lives at `main` on the forge.
      const policy = derive({
        branches: [localBranch("main", "main-oid"), published({ upstream: "origin/main" })],
        forge: githubForge,
      });
      expect(policy.branchUrl).toBe("https://github.com/o/r/tree/main");
      expect(policy.forgeName).toBe("GitHub");
    });

    it("links a remote-tracking ref by dropping its remote prefix", () => {
      const policy = derive({
        branch: "origin/feature",
        branches: [localBranch("main", "main-oid"), remoteBranch("origin/feature")],
        forge: githubForge,
      });
      expect(policy.branchUrl).toBe("https://github.com/o/r/tree/feature");
      expect(policy.forgeName).toBe("GitHub");
    });

    it("hides the link on an unknown forge (kind null → would fall back to repo root)", () => {
      const policy = derive({
        branches: [localBranch("main", "main-oid"), published()],
        forge: { ...githubForge, kind: null },
      });
      expect(policy.branchUrl).toBeNull();
      expect(policy.forgeName).toBeNull();
    });

    it("hides the link when the upstream is stale (remote branch deleted → would 404)", () => {
      const policy = derive({
        branches: [
          localBranch("main", "main-oid"),
          published({ sync: { status: "staleUpstream", upstream: "origin/feature", ahead: 1, behind: 0 } }),
        ],
        forge: githubForge,
      });
      expect(policy.branchUrl).toBeNull();
    });

    it("hides the link for a `.`-remote upstream (tracks another local branch)", () => {
      const policy = derive({
        branches: [
          localBranch("main", "main-oid"),
          published({ upstream: "main", upstreamRemote: "." }),
        ],
        forge: githubForge,
      });
      expect(policy.branchUrl).toBeNull();
    });
  });
});
