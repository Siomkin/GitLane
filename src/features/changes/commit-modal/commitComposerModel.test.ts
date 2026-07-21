import { describe, expect, it } from "vitest";

import {
  BranchKind,
  RefKind,
  type BranchInfo,
  type CommitNode,
  type FileChange,
  type RepoGraph,
  type RepoSummary,
  type TerminalAgent,
  type WorkingChanges,
} from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { ComposerMode, parseConventionalMessage } from "@/lib/conventionalCommit";
import {
  branchSyncIsUpToDate,
  buildCommitAgentInstruction,
  buildDraftAgentInstruction,
  commitDraftMailboxName,
  deriveCommitComposer,
  nextAmendTransition,
  publishPromptDetails,
} from "./commitComposerModel";

const summary: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "head",
  detached: false,
};

const staged: FileChange = {
  path: "src/feature.ts",
  status: "M",
  add: 1,
  del: 0,
  binary: false,
};

const changes: WorkingChanges = {
  staged: [staged],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};

const head: CommitNode = {
  id: "head",
  shortId: "abc1234",
  summary: "previous summary",
  body: "Previous body.",
  authorName: "Ada",
  authorEmail: "ada@example.test",
  timestamp: 1,
  parents: [],
  lane: 0,
  row: 0,
  color: 0,
  refs: [{ name: "origin/main", kind: RefKind.Remote }],
};

const graph: RepoGraph = {
  commits: [head],
  edges: [],
  laneCount: 1,
  head: head.id,
  truncated: false,
};

const agent = (over: Partial<TerminalAgent> = {}): TerminalAgent => ({
  id: "codex",
  name: "codex",
  command: "codex",
  description: "",
  enabled: true,
  available: true,
  ...over,
});

const localBranch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "main",
  kind: BranchKind.Local,
  target: "head",
  isHead: true,
  upstream: "origin/main",
  remote: null,
  sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
  ...over,
});

describe("commitComposerModel", () => {
  it("derives commit, amend, agent, and published-head eligibility", () => {
    const model = deriveCommitComposer({
      changes,
      summary,
      forge: null,
      graph,
      message: "feat: extracted controller",
      mode: ComposerMode.Conventional,
      fields: parseConventionalMessage("feat: extracted controller"),
      identityUsable: true,
      agents: [agent(), agent({ id: "off", enabled: false })],
      agentDraft: { repoPath: "/repo", agentName: "codex" },
      amend: true,
    });

    expect(model.canCommit).toBe(true);
    expect(model.canAmend).toBe(true);
    expect(model.headPublished).toBe(true);
    expect(model.agents.map((item) => item.id)).toEqual(["codex"]);
    expect(model.draftingAgent).toBe("codex");
    expect(model.draftDisabled).toBe(true);
    expect(model.pushBlockedTitle).toContain("Force push with lease");
  });

  it("keeps the existing disabled-title precedence", () => {
    const model = deriveCommitComposer({
      changes: { ...changes, staged: [] },
      summary,
      forge: null,
      graph: null,
      message: "",
      mode: ComposerMode.Message,
      fields: parseConventionalMessage(""),
      identityUsable: false,
      agents: [agent()],
      agentDraft: null,
      amend: false,
    });

    expect(model.canCommit).toBe(false);
    expect(model.commitDisabledTitle).toBe("Stage files to commit");
    expect(model.draftDisabledTitle).toBe("Stage files before drafting a commit message");
    expect(model.agentsDisabledTitle).toBe("Stage files before committing with an agent");
  });

  it("prefills and clears only the amend-owned previous message", () => {
    expect(nextAmendTransition(true, false, "", head)).toEqual({
      amend: true,
      message: "previous summary\n\nPrevious body.",
    });
    expect(
      nextAmendTransition(true, true, "previous summary\n\nPrevious body.", head),
    ).toEqual({ amend: false, message: "" });
    expect(nextAmendTransition(true, true, "edited meanwhile", head)).toEqual({
      amend: false,
      message: null,
    });
    expect(nextAmendTransition(false, false, "", null)).toBeNull();
  });

  it("derives publish prompt defaults and requires exact up-to-date sync", () => {
    const branches = [
      localBranch({
        upstream: null,
        sync: { status: "noUpstream", upstream: null, ahead: 0, behind: 0 },
      }),
    ];

    expect(publishPromptDetails(summary, branches)).toMatchObject({
      title: "Publish main",
      defaultValue: "origin/main",
      confirmLabel: "Publish",
    });
    expect(branchSyncIsUpToDate(branches, "main")).toBe(false);
    expect(branchSyncIsUpToDate([localBranch()], "main")).toBe(true);
    expect(
      branchSyncIsUpToDate([
        localBranch({
          sync: { status: "unknown", upstream: "origin/main", ahead: 0, behind: 0 },
        }),
      ], "main"),
    ).toBe(false);
  });

  it("builds direct and amend agent commit instructions without changing precedence", () => {
    expect(buildCommitAgentInstruction(" fix: explicit ", false, "configured")).toBe(
      "fix: explicit",
    );
    expect(buildCommitAgentInstruction("", false, " configured ")).toBe("configured");
    expect(buildCommitAgentInstruction("", true, "configured")).toContain(
      "add them to the previous commit",
    );
  });

  it("builds the one-shot draft mailbox contract from the existing draft", () => {
    const filename = commitDraftMailboxName("1234-5678");
    const instruction = buildDraftAgentInstruction(
      "Draft a conventional message.",
      'fix: preserve "quotes"\n\nExplain "why".',
      filename,
    );

    expect(filename).toBe("gitlane-commit-draft-12345678");
    expect(instruction).toBe(
      'Draft a conventional message. Use it to improve this existing conventional commit message: "fix: preserve \\"quotes\\"\\n\\nExplain \\"why\\".".\n\n' +
      "Do not commit. Do not create, edit, stage, delete, or otherwise alter any tracked or untracked working-tree file. " +
      "For delivery only, you are explicitly authorized to create a temporary sibling and the final mailbox inside this repository's Git metadata at the path printed by: git rev-parse --git-path 'gitlane-commit-draft-12345678'. " +
      "These two Git-metadata paths are the only authorized filesystem writes and do not count as working-tree modifications. " +
      "Finish all analysis before delivering the draft. Using shell file commands, not apply_patch, write only the final plain-text commit message to `<mailbox-path>.tmp`. " +
      "As your final tool action, atomically rename that sibling temporary file to `<mailbox-path>`. " +
      "That destination is a one-shot mailbox which GitLane deletes immediately after reading. A successful rename means delivery succeeded even if the destination disappears; do not inspect, read, list, or verify it afterward. " +
      "Once the rename succeeds, end the turn immediately and run no more tools or commands.",
    );
  });
});
