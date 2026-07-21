import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepo } from "./repo";
import { useTerminals } from "./terminals";
import { useUi } from "./ui";

const realTakeAgentCommitDraft = useRepo.getState().takeAgentCommitDraft;

// View-routing transitions (GL-155): the tab state lives here so store actions
// — not component effects — own its transitions.
beforeEach(() => {
  useUi.setState({
    leftTab: "history",
    changesAll: false,
    stackedReview: null,
    navOpen: false,
    reviewNotes: [],
    agentMessageOpen: false,
    histSearchOpen: false,
    histQuery: "",
    histFilter: "all",
    histFilterOpen: false,
    onboardingOpen: false,
    terminalView: "hidden",
    terminalViewByRepo: {},
    terminalHeight: 480,
    terminalHorizontalLayout: null,
    terminalExpanded: false,
    commitMsg: "",
    agentCommitDraft: null,
    repoSettingsOpen: false,
    createBranchOpen: false,
    createBranchStart: null,
    createBranchName: null,
    createPrOpen: false,
    createPrGeneration: 0,
    recoveryOpen: false,
    confirm: null,
    prompt: null,
    handoff: null,
    handoffRunning: false,
    deleteWorktree: null,
    removeDetached: null,
  });
  useTerminals.setState({ byRepo: {} });
  useRepo.setState({ summary: null });
});

afterEach(() => {
  vi.useRealTimers();
  useRepo.setState({ takeAgentCommitDraft: realTakeAgentCommitDraft });
  useUi.setState({ agentCommitDraft: null });
});

describe("view-tab transitions", () => {
  it("openChangesView lands on the changes tab in the requested flavour", () => {
    useUi.getState().openChangesView(true);
    expect(useUi.getState().leftTab).toBe("changes");
    expect(useUi.getState().changesAll).toBe(true);

    useUi.getState().openChangesView();
    expect(useUi.getState().changesAll).toBe(false);
  });

  it("openCommit reveals the inline composer in the Working Changes inspector", () => {
    useUi.setState({ leftTab: "history", rightTab: "files", changesAll: true });

    useUi.getState().openCommit();

    expect(useUi.getState()).toMatchObject({
      leftTab: "changes",
      rightTab: "details",
      changesAll: false,
    });
  });

  it("onWorkingTreeClean leaves the changes view but never touches other tabs", () => {
    useUi.setState({ leftTab: "changes" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("history");

    useUi.setState({ leftTab: "pulls" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("pulls");
  });

  it("onRepoSwitched atomically clears repo-bound views, dialogs, drafts, and chrome", () => {
    useUi.setState({
      leftTab: "changes",
      changesAll: true,
      // Outranks the history tab in deriveCenterView — a leftover one would
      // render the previous repo's oid against the new repo.
      stackedReview: { oid: "abc123", title: "Old repo commit" },
      navOpen: true,
      draggingFrom: { name: "old-branch", kind: "local" },
      actionMenu: {
        x: 1,
        y: 2,
        from: { name: "old-branch", kind: "local" },
        to: { kind: "commit", sha: "old-oid", shortSha: "old" },
      },
      contextMenu: { x: 1, y: 2, branch: "old-branch", isCurrent: false },
      commitMenu: { x: 1, y: 2, sha: "old-oid", shortSha: "old" },
      stashMenu: { x: 1, y: 2, oid: "old-stash", message: "old stash" },
      fileMenu: { x: 1, y: 2, path: "shared.txt", discard: { staged: false } },
      wipMenu: { x: 1, y: 2 },
      tagMenu: { x: 1, y: 2, name: "v1", sha: "old-oid", refOid: "old-tag-oid" },
      worktreeMenu: { x: 1, y: 2, path: "/old-wt", name: "old-wt", isMain: false },
      reviewNotes: [
        {
          id: "work#a.ts#R1-R1",
          surface: "work",
          file: "a.ts",
          side: "R",
          line: 1,
          fromRef: "R1",
          toRef: "R1",
          lineRef: "R1",
          code: "x",
          body: "note",
        },
      ],
      agentMessageOpen: true,
      histSearchOpen: true,
      histQuery: "fix",
      histFilter: "merges",
      histFilterOpen: true,
      onboardingOpen: true,
      commitMsg: "old message",
      agentCommitDraft: {
        token: "old-token",
        agentName: "codex",
        repoPath: "/old-repo",
        startedAt: 1,
      },
      repoSettingsOpen: true,
      createBranchOpen: true,
      createBranchStart: "old-base-oid",
      createBranchName: "old-branch-name",
      createPrOpen: true,
      createPrGeneration: 41,
      recoveryOpen: true,
      confirm: { title: "Reset old repo?", onConfirm: () => {} },
      prompt: { title: "Old repo tag", onSubmit: () => {} },
      handoff: { branch: "old-branch", sourcePath: "/old-repo", sourceChanges: 1 },
      handoffRunning: false,
      deleteWorktree: { branch: "old-branch", worktreePath: "/old-worktree" },
      removeDetached: {
        targets: [
          {
            name: "old-detached",
            path: "/old-detached",
            branch: null,
            head: "old-detached-oid",
            isMain: false,
            locked: false,
            prunable: false,
          },
        ],
      },
    });

    useUi.getState().onRepoSwitched();

    const s = useUi.getState();
    expect(s.leftTab).toBe("history");
    expect(s.changesAll).toBe(false);
    expect(s.stackedReview).toBeNull();
    expect(s.navOpen).toBe(false);
    expect(s.draggingFrom).toBeNull();
    expect(s).toMatchObject({
      actionMenu: null,
      contextMenu: null,
      commitMenu: null,
      stashMenu: null,
      fileMenu: null,
      wipMenu: null,
      tagMenu: null,
      worktreeMenu: null,
    });
    expect(s.reviewNotes).toEqual([]);
    expect(s.agentMessageOpen).toBe(false);
    expect(s.histSearchOpen).toBe(false);
    expect(s.histQuery).toBe("");
    expect(s.histFilter).toBe("all");
    expect(s.histFilterOpen).toBe(false);
    expect(s.onboardingOpen).toBe(false);
    expect(s.commitMsg).toBe("");
    expect(s.agentCommitDraft).toBeNull();
    expect(s.repoSettingsOpen).toBe(false);
    expect(s.createBranchOpen).toBe(false);
    expect(s.createBranchStart).toBeNull();
    expect(s.createBranchName).toBeNull();
    expect(s.createPrOpen).toBe(false);
    expect(s.createPrGeneration).toBe(42);
    expect(s.recoveryOpen).toBe(false);
    expect(s.confirm).toBeNull();
    expect(s.prompt).toBeNull();
    expect(s.handoff).toBeNull();
    expect(s.deleteWorktree).toBeNull();
    expect(s.removeDetached).toBeNull();
  });

  it("keeps an in-flight handoff through its intentional destination switch", () => {
    const handoff = { branch: "feature", sourcePath: "/source", sourceChanges: 1 };
    useUi.setState({ handoff, handoffRunning: true });

    useUi.getState().onRepoSwitched();

    expect(useUi.getState().handoff).toEqual(handoff);
    useUi.setState({ handoff: null, handoffRunning: false });
  });

  it("keeps terminal visibility scoped to each repository", () => {
    useRepo.setState({
      summary: {
        path: "/repoA",
        workdir: "/repoA",
        headBranch: "main",
        headOid: "a",
        detached: false,
      },
    });
    useUi.getState().expandTerminal();
    expect(useUi.getState().terminalViewByRepo).toEqual({ "/repoA": "open" });

    useRepo.setState({
      summary: {
        path: "/repoB",
        workdir: "/repoB",
        headBranch: "main",
        headOid: "b",
        detached: false,
      },
    });
    useUi.getState().onRepoSwitched();
    expect(useUi.getState().terminalView).toBe("hidden");

    useUi.getState().expandTerminal();
    expect(useUi.getState().terminalViewByRepo["/repoB"]).toBe("open");

    useRepo.setState({
      summary: {
        path: "/repoA",
        workdir: "/repoA",
        headBranch: "main",
        headOid: "a",
        detached: false,
      },
    });
    useUi.getState().onRepoSwitched();
    expect(useUi.getState().terminalView).toBe("open");
  });

  it("keeps polling while the inline composer remains available and fills its message", async () => {
    vi.useFakeTimers();
    const takeAgentCommitDraft = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("feat(changes): draft from agent");
    useRepo.setState({ takeAgentCommitDraft });
    useRepo.setState({
      summary: {
        path: "/repo",
        workdir: "/repo",
        headBranch: "main",
        headOid: "abc123",
        detached: false,
      },
    });
    useUi.setState({
      commitMsg: "initial guidance",
    });

    useUi.getState().startAgentCommitDraft(
      { token: "draft-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      "codex",
    );

    expect(useUi.getState().terminalView).toBe("open");
    expect(useTerminals.getState().byRepo["/repo"].tabs).toHaveLength(1);
    expect(useUi.getState().terminalInject).toEqual(expect.objectContaining({
      text: "draft this commit",
      command: "codex",
      tabId: useTerminals.getState().byRepo["/repo"].activeId,
    }));

    await vi.advanceTimersByTimeAsync(500);
    expect(takeAgentCommitDraft).toHaveBeenLastCalledWith("/repo", "draft-token");
    expect(useUi.getState().commitMsg).toBe("initial guidance");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(useUi.getState().agentCommitDraft).toBeNull();
    expect(useUi.getState().commitMsg).toBe("feat(changes): draft from agent");
    expect(useUi.getState().terminalView).toBe("collapsed");
    expect(useUi.getState().terminalExpanded).toBe(false);
  });

  it("opens agent drafting in a new tab without replacing a running terminal", () => {
    vi.useFakeTimers();
    useRepo.setState({
      summary: {
        path: "/repo",
        workdir: "/repo",
        headBranch: "main",
        headOid: "abc123",
        detached: false,
      },
    });
    const existingId = useTerminals.getState().openTab("/repo");

    useUi.getState().startAgentCommitDraft(
      { token: "new-tab-token", agentName: "codex", repoPath: "/repo", startedAt: 1 },
      "draft this commit",
      "codex --model gpt-5.6-sol",
    );

    const repo = useTerminals.getState().byRepo["/repo"];
    expect(repo.tabs).toHaveLength(2);
    expect(repo.activeId).not.toBe(existingId);
    expect(repo.tabs.some((tab) => tab.id === existingId)).toBe(true);
    expect(useUi.getState().terminalInject).toMatchObject({
      text: "draft this commit",
      command: "codex --model gpt-5.6-sol",
      repoKey: "/repo",
      tabId: repo.activeId,
    });
    useUi.getState().cancelAgentCommitDraft();
  });

  it("preserves an explicitly hidden terminal when an agent draft arrives", async () => {
    vi.useFakeTimers();
    useRepo.setState({ takeAgentCommitDraft: vi.fn().mockResolvedValue("fix: delivered") });

    useUi.getState().startAgentCommitDraft(
      { token: "hidden-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      "codex",
    );
    useUi.getState().hideTerminal();

    await vi.advanceTimersByTimeAsync(500);

    expect(useUi.getState().commitMsg).toBe("fix: delivered");
    expect(useUi.getState().terminalView).toBe("hidden");
  });

  it("normalizes user-selected terminal edge positions", () => {
    useUi.getState().setTerminalHorizontalInsets(-20, 1280.4);
    expect(useUi.getState()).toMatchObject({
      // Floored at TERMINAL_EDGE_MARGIN so stored insets match what renders.
      terminalHorizontalLayout: { leftInset: 10, rightInset: 1280 },
    });

    useUi.getState().setTerminalHorizontalInsets(9000, 20);
    expect(useUi.getState()).toMatchObject({
      terminalHorizontalLayout: { leftInset: 8192, rightInset: 20 },
    });
  });

  it("persists the user-selected terminal size and position", () => {
    useUi.getState().adjustTerminalHeight(-120);
    useUi.getState().setTerminalVertical(120, 300);
    useUi.getState().setTerminalHorizontalInsets(180, 340);

    const partialize = useUi.persist.getOptions().partialize;
    const persisted = partialize?.(useUi.getState()) as Partial<ReturnType<typeof useUi.getState>>;

    expect(persisted).toMatchObject({
      terminalHeight: 300,
      terminalBottomInset: 120,
      terminalHorizontalLayout: { leftInset: 180, rightInset: 340 },
    });
  });

  it("caps terminal height growth to the container-derived maximum", () => {
    useUi.setState({ terminalHeight: 400 });
    // Without a cap, +600 would clamp only at the 860 ceiling.
    useUi.getState().adjustTerminalHeight(600);
    expect(useUi.getState().terminalHeight).toBe(860);

    // With a caller-supplied cap (room above a lifted floor), it stops there.
    useUi.setState({ terminalHeight: 400 });
    useUi.getState().adjustTerminalHeight(600, 500);
    expect(useUi.getState().terminalHeight).toBe(500);
  });

  it("normalizes the bottom inset and height set together", () => {
    useUi.getState().setTerminalVertical(-40, 9000);
    expect(useUi.getState()).toMatchObject({
      terminalBottomInset: 10,
      terminalHeight: 860,
    });
  });

  it("sets, normalizes, clears, and persists identity colour overrides", () => {
    useUi.getState().setIdentityColor(" Jane@Example.com ", "#123456");
    expect(useUi.getState().identityColors).toEqual({ "jane@example.com": "#123456" });

    const partialize = useUi.persist.getOptions().partialize;
    const persisted = partialize?.(useUi.getState()) as Partial<ReturnType<typeof useUi.getState>>;
    expect(persisted.identityColors).toEqual({ "jane@example.com": "#123456" });

    useUi.getState().setIdentityColor("jane@example.com", null);
    expect(useUi.getState().identityColors).toEqual({});
  });

  it("ignores an agent draft that resolves after a repository switch", async () => {
    vi.useFakeTimers();
    let resolveDraft: (draft: string) => void = () => {};
    const takeAgentCommitDraft = vi.fn(() => new Promise<string>((resolve) => {
      resolveDraft = resolve;
    }));
    useRepo.setState({ takeAgentCommitDraft });
    useUi.setState({ commitMsg: "keep this" });

    useUi.getState().startAgentCommitDraft(
      { token: "stale-token", agentName: "claude", repoPath: "/old-repo", startedAt: Date.now() },
      "draft this commit",
      "claude",
    );
    await vi.advanceTimersByTimeAsync(500);

    useUi.getState().onRepoSwitched();
    resolveDraft("fix: stale result");
    await Promise.resolve();
    await Promise.resolve();

    expect(useUi.getState().agentCommitDraft).toBeNull();
    expect(useUi.getState().commitMsg).toBe("");
  });
});

describe("auto-fetch cadence (GL-221)", () => {
  it("accepts allowed values and sanitizes anything else to the default", () => {
    useUi.getState().setAutoFetchMinutes(30);
    expect(useUi.getState().autoFetchMinutes).toBe(30);
    useUi.getState().setAutoFetchMinutes(7 as never);
    expect(useUi.getState().autoFetchMinutes).toBe(15);
  });
});
