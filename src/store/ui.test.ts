import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepo } from "./repo";
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
    commitOpen: false,
    commitMsg: "",
    commitExcluded: {},
    agentCommitDraft: null,
  });
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

  it("onWorkingTreeClean leaves the changes view but never touches other tabs", () => {
    useUi.setState({ leftTab: "changes" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("history");

    useUi.setState({ leftTab: "pulls" });
    useUi.getState().onWorkingTreeClean();
    expect(useUi.getState().leftTab).toBe("pulls");
  });

  it("onRepoSwitched resets the view, history filters, notes, and transient chrome", () => {
    useUi.setState({
      leftTab: "changes",
      changesAll: true,
      // Outranks the history tab in deriveCenterView — a leftover one would
      // render the previous repo's oid against the new repo.
      stackedReview: { oid: "abc123", title: "Old repo commit" },
      navOpen: true,
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
      commitOpen: true,
      agentCommitDraft: {
        token: "old-token",
        agentName: "codex",
        repoPath: "/old-repo",
        startedAt: 1,
      },
    });

    useUi.getState().onRepoSwitched();

    const s = useUi.getState();
    expect(s.leftTab).toBe("history");
    expect(s.changesAll).toBe(false);
    expect(s.stackedReview).toBeNull();
    expect(s.navOpen).toBe(false);
    expect(s.reviewNotes).toEqual([]);
    expect(s.agentMessageOpen).toBe(false);
    expect(s.histSearchOpen).toBe(false);
    expect(s.histQuery).toBe("");
    expect(s.histFilter).toBe("all");
    expect(s.histFilterOpen).toBe(false);
    expect(s.onboardingOpen).toBe(false);
    expect(s.commitOpen).toBe(false);
    expect(s.agentCommitDraft).toBeNull();
  });

  it("keeps polling after the modal closes and reopens it with the agent draft", async () => {
    vi.useFakeTimers();
    const takeAgentCommitDraft = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("feat(changes): draft from agent");
    useRepo.setState({ takeAgentCommitDraft });
    useUi.setState({
      commitOpen: true,
      commitMsg: "initial guidance",
      commitExcluded: { "skip-me.ts": true },
    });

    useUi.getState().startAgentCommitDraft(
      { token: "draft-token", agentName: "codex", repoPath: "/repo", startedAt: Date.now() },
      "draft this commit",
      "codex",
    );

    expect(useUi.getState().commitOpen).toBe(false);
    expect(useUi.getState().terminalView).toBe("open");
    expect(useUi.getState().terminalInject).toEqual(expect.objectContaining({
      text: "draft this commit",
      command: "codex",
    }));

    await vi.advanceTimersByTimeAsync(500);
    expect(takeAgentCommitDraft).toHaveBeenLastCalledWith("/repo", "draft-token");
    expect(useUi.getState().commitOpen).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(useUi.getState().agentCommitDraft).toBeNull();
    expect(useUi.getState().commitMsg).toBe("feat(changes): draft from agent");
    expect(useUi.getState().commitExcluded).toEqual({ "skip-me.ts": true });
    expect(useUi.getState().commitOpen).toBe(true);
  });

  it("ignores an agent draft that resolves after a repository switch", async () => {
    vi.useFakeTimers();
    let resolveDraft: (draft: string) => void = () => {};
    const takeAgentCommitDraft = vi.fn(() => new Promise<string>((resolve) => {
      resolveDraft = resolve;
    }));
    useRepo.setState({ takeAgentCommitDraft });
    useUi.setState({ commitOpen: true, commitMsg: "keep this" });

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
    expect(useUi.getState().commitMsg).toBe("keep this");
    expect(useUi.getState().commitOpen).toBe(false);
  });
});
