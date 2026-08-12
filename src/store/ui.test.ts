import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepo } from "./repo";
import { useTerminals } from "./terminals";
import { acpAgent } from "@/test/agents";
import {
  actionMenuOf,
  commitMenuOf,
  contextMenuOf,
  fileMenuOf,
  MenuKind,
  overlayOpen,
  persistedUiState,
  useUi,
} from "./ui";


/** Let an already-resolved promise chain settle. The ACP draft path has no
 *  timers to advance — it awaits one IPC call — so the mailbox tests' fake
 *  timers are neither needed nor available here. */
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

// View-routing transitions (GL-155): the tab state lives here so store actions
// — not component effects — own its transitions.
beforeEach(() => {
  // Clear the outgoing repo *first*: `onRepoSwitched` restores the terminal
  // chrome remembered for `summary.path`, so switching away from a still-set
  // previous test's repo would carry that test's `terminalView` in as the
  // baseline rather than "hidden".
  useRepo.setState({ summary: null });
  // The store states what a repo switch resets (GL-358); this used to transcribe
  // that write set by hand, which is how a test stops testing the real thing.
  useUi.getState().onRepoSwitched({ dropRunningHandoff: true });
  // What a switch deliberately preserves, put back to a known baseline.
  useUi.setState({
    handoffRunning: false,
    terminalViewByRepo: {},
    terminalHeight: 480,
    terminalHorizontalLayout: null,
    createPrGeneration: 0,
  });
  useTerminals.setState({ byRepo: {} });
});

afterEach(() => {
  vi.useRealTimers();
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
      menu: { kind: MenuKind.Action, state: {
        x: 1,
        y: 2,
        from: { name: "old-branch", kind: "local" },
        to: { kind: "commit", sha: "old-oid", shortSha: "old" },
      } },
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
      menu: null,
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

  it("asks the ACP agent directly and lands its trimmed answer", async () => {
    const acpPrompt = vi.fn(
      async (
        _command: string,
        _repoPath: string,
        _model: string,
        _config: Record<string, string>,
        _prompt: string,
        _runId: string,
      ) => "feat(acp): draft over the protocol\n",
    );
    useRepo.setState({ acpPrompt });
    useUi.setState({ commitMsg: "" });

    useUi.getState().startAgentCommitDraft(
      { token: "acp-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      acpAgent("codex", { model: "gpt-5.6-sol[low]" }),
    );

    await flushMicrotasks();

    expect(acpPrompt).toHaveBeenCalledWith(
      "codex-acp",
      "/repo",
      "gpt-5.6-sol[low]",
      {},
      "draft this commit",
      "acp-token",
    );
    // No terminal is opened for a draft any more, and the answer is trimmed.
    expect(useTerminals.getState().byRepo["/repo"]).toBeUndefined();
    expect(useUi.getState().commitMsg).toBe("feat(acp): draft over the protocol");
    expect(useUi.getState().agentCommitDraft).toBeNull();
  });

  it("stops the adapter when the draft is cancelled, not just the banner", async () => {
    // Clearing only the banner left the agent running unwatched for up to five
    // minutes, still able to call tools.
    const acpCancel = vi.fn(async () => true);
    useRepo.setState({ acpPrompt: vi.fn(async () => "never lands"), acpCancel });

    useUi.getState().startAgentCommitDraft(
      { token: "stop-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      acpAgent("codex"),
    );
    useUi.getState().cancelAgentCommitDraft();

    expect(acpCancel).toHaveBeenCalledWith("stop-token");
    expect(useUi.getState().agentCommitDraft).toBeNull();

    // Nothing running: Stop is a no-op rather than a stray cancel.
    acpCancel.mockClear();
    useUi.getState().cancelAgentCommitDraft();
    expect(acpCancel).not.toHaveBeenCalled();
  });

  it("clears the ACP draft banner and reports why when the agent fails", async () => {
    useRepo.setState({
      acpPrompt: vi.fn(async () => {
        throw new Error("`missing-adapter` was not found.");
      }),
    });

    useUi.getState().startAgentCommitDraft(
      { token: "acp-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      acpAgent("codex"),
    );
    await flushMicrotasks();

    // A stuck banner with no explanation was the old path's worst failure.
    expect(useUi.getState().agentCommitDraft).toBeNull();
    expect(useUi.getState().commitMsg).toBe("");
  });

  it("never touches the terminal while drafting", async () => {
    useRepo.setState({ acpPrompt: vi.fn(async () => "fix: delivered") });
    useUi.getState().hideTerminal();

    useUi.getState().startAgentCommitDraft(
      { token: "hidden-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      acpAgent("codex"),
    );
    await flushMicrotasks();

    expect(useUi.getState().commitMsg).toBe("fix: delivered");
    // Drafting used to open (and then collapse) a terminal tab. Over ACP it has
    // no business changing terminal chrome at all.
    expect(useUi.getState().terminalView).toBe("hidden");
    expect(useTerminals.getState().byRepo["/repo"]).toBeUndefined();
    expect(useUi.getState().terminalInject).toBeNull();
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
    let resolveDraft: (draft: string) => void = () => {};
    useRepo.setState({
      acpPrompt: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveDraft = resolve;
          }),
      ),
    });
    useUi.setState({ commitMsg: "keep this" });

    useUi.getState().startAgentCommitDraft(
      { token: "stale-token", agentName: "claude", repoPath: "/old-repo", startedAt: Date.now() },
      "draft this commit",
      acpAgent("claude"),
    );

    useUi.getState().onRepoSwitched();
    resolveDraft("fix: stale result");
    await flushMicrotasks();

    // The switch cleared the request; a late answer must not land in the new
    // repo's composer.
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

// The persistence contract, now that the keys are declared across six slices
// plus this file (GL-357). Slicing must not change what a restart restores, and
// a slice that forgets to declare a key would otherwise drop a user's
// preference silently.
describe("persisted UI preferences", () => {
  it("persists exactly the view preferences and nothing transient", () => {
    expect(Object.keys(persistedUiState(useUi.getState())).sort()).toEqual([
      "accent",
      "autoCheckUpdates",
      "autoFetchEnabled",
      "autoFetchMinutes",
      "betaUpdates",
      "branchWidth",
      "collapsed",
      "commitComposerMode",
      "commitDraftAgent",
      "density",
      "fileListView",
      "graphWidthsByRepo",
      "identityColors",
      "lastUpdateCheckAt",
      "leftWidth",
      "pinnedNavRefsByRepo",
      "prFilter",
      "rightWidth",
      "showCommitNodeIcons",
      "terminalBottomInset",
      "terminalExpanded",
      "terminalHeight",
      "terminalHorizontalLayout",
      "theme",
      "whenWidth",
    ]);
  });
});

// The one definition of "this was bound to the repo that just left" (GL-358).
// It used to be written five times — here, and as hand-picked `close*()` calls
// in repoLifecycleActions, repoTabActions and two places in repoMissing — so a
// "dialog survives a repo switch" bug could live in any of them.
describe("onRepoSwitched — the repo-switch reset contract", () => {
  const openEverythingRepoBound = () =>
    useUi.setState({
      leftTab: "changes",
      rightTab: "files",
      changesAll: true,
      stackedReview: { oid: "abc", title: "old repo commit" },
      navOpen: true,
      draggingFrom: { name: "feature", kind: "local" },
      menu: { kind: MenuKind.Context, state: { x: 0, y: 0, branch: "feature", isCurrent: false } },
      repoSettingsOpen: true,
      createBranchOpen: true,
      createBranchStart: "main",
      createBranchName: "draft",
      createPrOpen: true,
      createPrHead: "feature",
      onboardingOpen: true,
      recoveryOpen: true,
      confirm: { title: "Delete?", onConfirm: () => {} },
      prompt: { title: "Rename", onSubmit: () => {} },
      editCommitMessage: { defaultValue: "msg", onSubmit: () => {} },
      deleteWorktree: { branch: "feature", worktreePath: "/work/feature" },
      removeDetached: { targets: [] },
      reviewNotes: [
        {
          id: "n1",
          surface: "review",
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
      agentMessageSurfaces: ["review"],
      agentMessageBranch: "feature",
      histSearchOpen: true,
      histQuery: "fix",
      histFilter: "merges",
      commitMsg: "half-typed message",
      terminalExpanded: true,
    });

  it("clears every repo-bound field in one call", () => {
    openEverythingRepoBound();
    const before = useUi.getState().createPrGeneration;

    useUi.getState().onRepoSwitched();

    const s = useUi.getState();
    expect(s.leftTab).toBe("history");
    expect(s.rightTab).toBe("details");
    expect(s.changesAll).toBe(false);
    expect(s.stackedReview).toBeNull();
    expect(s.navOpen).toBe(false);
    expect(s.draggingFrom).toBeNull();
    expect(s.menu).toBeNull();
    expect(s.repoSettingsOpen).toBe(false);
    expect(s.createBranchOpen).toBe(false);
    expect(s.createBranchStart).toBeNull();
    expect(s.createBranchName).toBeNull();
    expect(s.createPrOpen).toBe(false);
    expect(s.createPrHead).toBeNull();
    expect(s.onboardingOpen).toBe(false);
    expect(s.recoveryOpen).toBe(false);
    expect(s.confirm).toBeNull();
    expect(s.prompt).toBeNull();
    expect(s.editCommitMessage).toBeNull();
    expect(s.deleteWorktree).toBeNull();
    expect(s.removeDetached).toBeNull();
    expect(s.reviewNotes).toEqual([]);
    expect(s.agentMessageOpen).toBe(false);
    expect(s.agentMessageSurfaces).toEqual([]);
    expect(s.agentMessageBranch).toBeNull();
    expect(s.histSearchOpen).toBe(false);
    expect(s.histQuery).toBe("");
    expect(s.histFilter).toBe("all");
    expect(s.commitMsg).toBe("");
    expect(s.terminalExpanded).toBe(false);
    // The create-PR form advances rather than resets, so a submission deferred
    // by the old instance cannot close the next one.
    expect(s.createPrGeneration).toBe(before + 1);
  });

  it("keeps a running hand-off, which switches repos on purpose", () => {
    const handoff = { branch: "feature", sourcePath: "/work/feature", sourceChanges: 0 };
    useUi.setState({ handoff, handoffRunning: true });

    useUi.getState().onRepoSwitched();

    // Its own success path routes through loadRepo(destination); closing it
    // there would drop the result screen mid-move (GL-105).
    expect(useUi.getState().handoff).toEqual(handoff);
  });

  it("drops even a running hand-off when its worktree is what went away", () => {
    useUi.setState({
      handoff: { branch: "feature", sourcePath: "/work/feature", sourceChanges: 0 },
      handoffRunning: true,
    });

    useUi.getState().onRepoSwitched({ dropRunningHandoff: true });

    expect(useUi.getState().handoff).toBeNull();
    // The dialog goes, the flag stays: the move is still running and must report
    // via toast, and `handoffRunning` is what tells loadRepo's cleanup a
    // hand-off's own destination switch from a genuine one (GL-105).
    expect(useUi.getState().handoffRunning).toBe(true);
  });
});

describe("the single menu slot (GL-363)", () => {
  const contextState = { x: 1, y: 2, branch: "feature", isCurrent: false };
  const fileState = { x: 3, y: 4, path: "a.ts" };

  it("opening any menu replaces the one already open", () => {
    useUi.getState().openMenu({ kind: MenuKind.Context, state: contextState });
    expect(contextMenuOf(useUi.getState())).toEqual(contextState);

    useUi.getState().openMenu({ kind: MenuKind.File, state: fileState });
    expect(contextMenuOf(useUi.getState())).toBeNull();
    expect(fileMenuOf(useUi.getState())).toEqual(fileState);
  });

  it("only the drag-drop action menu clears draggingFrom", () => {
    const drag = { name: "feature", kind: "local" } as const;

    useUi.setState({ draggingFrom: drag });
    useUi.getState().openMenu({ kind: MenuKind.Context, state: contextState });
    expect(useUi.getState().draggingFrom).toEqual(drag);

    useUi.getState().openMenu({
      kind: MenuKind.Action,
      state: { x: 1, y: 2, from: drag, to: { kind: "local", name: "main" } },
    });
    expect(useUi.getState().draggingFrom).toBeNull();
    expect(actionMenuOf(useUi.getState())).not.toBeNull();
  });

  it("overlayOpen sees an open menu, and modal openers close it", () => {
    useUi.getState().openMenu({ kind: MenuKind.Commit, state: { x: 0, y: 0, sha: "abc", shortSha: "abc" } });
    expect(overlayOpen(useUi.getState())).toBe(true);

    // A representative modal opener: the menu under it must not survive.
    useUi.getState().requestConfirm({ title: "Sure?", onConfirm: () => {} });
    expect(useUi.getState().menu).toBeNull();
    expect(overlayOpen(useUi.getState())).toBe(true); // the confirm now holds it
    useUi.getState().closeConfirm();
    expect(overlayOpen(useUi.getState())).toBe(false);
  });

  it("selectors narrow by kind and keep reference identity while open", () => {
    useUi.getState().openMenu({ kind: MenuKind.Commit, state: { x: 0, y: 0, sha: "abc", shortSha: "abc" } });
    const s = useUi.getState();
    expect(commitMenuOf(s)).toBe(s.menu && s.menu.state); // same object, no clone
    expect(fileMenuOf(s)).toBeNull();
    expect(contextMenuOf(s)).toBeNull();
  });
});
