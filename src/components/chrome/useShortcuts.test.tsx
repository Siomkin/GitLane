import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    if (command === "repository_stacks") return Promise.resolve([]);
    return invokeMock(command, args);
  },
}));

import { ForgeKind, type RepoForge, type RepoSummary, type WorkingChanges } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { isMac } from "@/lib/platform";
import { useRepo } from "@/store/repo";
import { usePulls } from "@/store/pulls";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { AiActionScopeKind } from "@/features/agents/ai-actions";
import { ActionBar } from "./action-bar/ActionBar";
import { TitleBar } from "./TitleBar";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc1234",
  detached: false,
};

const FORGE: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};

const DIRTY: WorkingChanges = {
  staged: [],
  unstaged: [{ path: "a.txt", status: "M", add: 1, del: 0, binary: false }],
  conflicted: [],
  advanced: emptyAdvancedState,
};

/** The primary modifier as this platform's build resolves it. */
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

/** Returns false when a handler called `preventDefault`. */
const press = (target: Document | HTMLElement, init: Record<string, unknown>) =>
  fireEvent.keyDown(target, { ...mod, ...init });

const loadRepo = vi.fn();
const push = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  loadRepo.mockReset();
  push.mockClear();
  useRepo.setState({
    summary: SUMMARY,
    forge: FORGE,
    branches: [],
    worktrees: [],
    remotes: [],
    loading: false,
    fetchingPath: null,
    openPaths: ["/repo", "/other", "/third"],
    changes: DIRTY,
    graph: null,
    missingRepo: null,
    wipSelected: false,
    selectedCommit: null,
    selectedCommits: [],
    inspectParentIndex: 0,
    stashes: [],
    loadRepo,
    push,
  });
  useUi.setState({
    leftTab: "history",
    changesAll: false,
    stackedReview: null,
    navOpen: false,
    confirm: null,
    prompt: null,
    settingsOpen: false,
    repoSettingsOpen: false,
    createBranchOpen: false,
    onboardingOpen: false,
    recoveryOpen: false,
    aiActions: null,
    repoGroups: [],
    repoLabelsByIdentity: {},
    collapsedRepoGroups: [],
  });
  usePulls.setState({ pullRequests: [] });
  useAccounts.setState({
    accounts: [],
    accountsError: null,
    accountsLoading: false,
    repoAccountRef: null,
    providerTokens: {},
    forgeAuth: [],
  });
});

/** The real app mounts both: the title bar owns tab switching, the toolbar owns
 *  the repository commands. */
const Chrome = () => (
  <>
    <TitleBar />
    <ActionBar />
  </>
);

describe("global shortcuts", () => {
  it("reviews all working changes on mod+Enter when the WIP row is selected", () => {
    useRepo.setState({ wipSelected: true });
    render(<Chrome />);

    expect(press(document, { code: "Enter" })).toBe(false);

    // The multi-file review, not the first file's diff.
    expect(useUi.getState().leftTab).toBe("changes");
    expect(useUi.getState().changesAll).toBe(true);
  });

  it("opens AI actions on mod+shift+A for the selected commit", () => {
    useRepo.setState({ selectedCommit: "c0ffee1", selectedCommits: ["c0ffee1"] });
    render(<Chrome />);

    expect(press(document, { code: "KeyA", shiftKey: true })).toBe(false);
    expect(useUi.getState().aiActions).toEqual({
      kind: AiActionScopeKind.Commits,
      commits: ["c0ffee1"],
    });
  });

  it("reviews the selected commit's files on mod+Enter", () => {
    useRepo.setState({ wipSelected: false, selectedCommit: "c0ffee1", selectedCommits: ["c0ffee1"] });
    render(<Chrome />);

    press(document, { code: "Enter" });

    expect(useUi.getState().stackedReview).toMatchObject({ kind: "commit", oid: "c0ffee1" });
  });

  it("reviews a merge against the active non-first parent as a range", () => {
    useRepo.setState({
      wipSelected: false,
      selectedCommit: "mergeoid",
      selectedCommits: ["mergeoid"],
      inspectParentIndex: 1,
      graph: {
        commits: [
          {
            id: "mergeoid",
            shortId: "mergeoi",
            summary: "Merged develop into feature",
            body: "",
            authorName: "Ada",
            authorEmail: "ada@example.test",
            timestamp: 1,
            parents: ["featureoid", "developoid"],
            lane: 0,
            row: 0,
            refs: [],
          },
        ],
        edges: [],
        laneCount: 1,
        wipLane: null,
        head: "mergeoid",
        truncated: false,
      },
    });
    render(<Chrome />);

    press(document, { code: "Enter" });

    expect(useUi.getState().stackedReview).toMatchObject({
      kind: "range",
      base: "developoid",
      head: "mergeoid",
    });
  });

  it("titles a stash review with its message, not a bare oid", () => {
    // A stash row parks its oid in `selectedCommit` but is not a graph commit.
    useRepo.setState({
      wipSelected: false,
      selectedCommit: "stash1",
      selectedCommits: ["stash1"],
      stashes: [{ index: 0, oid: "stash1", message: "WIP on main", timestamp: 1, baseOid: null, baseTimestamp: null, context: [] }],
    });
    render(<Chrome />);

    press(document, { code: "Enter" });

    expect(useUi.getState().stackedReview).toMatchObject({ kind: "commit", oid: "stash1", title: "WIP on main" });
  });

  it("reviews a multi-commit selection as one merged diff", () => {
    useRepo.setState({ wipSelected: false, selectedCommit: "a1", selectedCommits: ["a1", "b2"] });
    render(<Chrome />);

    press(document, { code: "Enter" });

    expect(useUi.getState().stackedReview).toMatchObject({ kind: "selection", commits: ["a1", "b2"] });
  });

  it("switches repository tabs by index, with 9 selecting the last tab", () => {
    render(<Chrome />);

    press(document, { code: "Digit2" });
    expect(loadRepo).toHaveBeenCalledWith("/other");

    press(document, { code: "Digit9" });
    expect(loadRepo).toHaveBeenLastCalledWith("/third");
  });

  it("switches tabs in the order groups draw them, not the stored order", () => {
    // /repo and /third share a group, so the strip draws [repo third] [other]:
    // ⌘2 must reach /third, the second tab the user sees.
    useUi.setState({
      repoGroups: [{ id: "g1", name: "Acme", color: "blue" }],
      repoLabelsByIdentity: { "/repo": { groupId: "g1" }, "/third": { groupId: "g1" } },
    });
    render(<Chrome />);

    press(document, { code: "Digit2" });
    expect(loadRepo).toHaveBeenCalledWith("/third");

    press(document, { code: "Digit9" });
    expect(loadRepo).toHaveBeenLastCalledWith("/other");
  });

  it("skips the tabs a collapsed group folds away", () => {
    // Drawn as `[Acme collapsed: /repo /third] /other`, with /repo active — a
    // collapsed group still draws the active tab, so the order is [repo, other].
    useUi.setState({
      repoGroups: [{ id: "g1", name: "Acme", color: "blue" }],
      repoLabelsByIdentity: { "/repo": { groupId: "g1" }, "/third": { groupId: "g1" } },
      collapsedRepoGroups: ["g1"],
    });
    render(<Chrome />);

    press(document, { code: "Digit2" });
    expect(loadRepo).toHaveBeenCalledWith("/other");

    // ⌘9 is "the last tab", so it counts DRAWN tabs — three are open but only
    // two are drawn, and `openPaths.length - 1` would index past the end and
    // silently do nothing.
    loadRepo.mockClear();
    press(document, { code: "Digit9" });
    expect(loadRepo).toHaveBeenCalledWith("/other");

    // Stepping wraps between the two drawn tabs; /third is not one of them.
    loadRepo.mockClear();
    press(document, isMac ? { code: "BracketLeft", shiftKey: true } : { code: "PageUp" });
    expect(loadRepo).toHaveBeenCalledWith("/other");
    expect(loadRepo).not.toHaveBeenCalledWith("/third");
  });

  it("puts a collapsed group's tabs back in the order once it expands", () => {
    useUi.setState({
      repoGroups: [{ id: "g1", name: "Acme", color: "blue" }],
      repoLabelsByIdentity: { "/repo": { groupId: "g1" }, "/third": { groupId: "g1" } },
      collapsedRepoGroups: [],
    });
    render(<Chrome />);

    press(document, { code: "Digit2" });
    expect(loadRepo).toHaveBeenCalledWith("/third");
  });

  it("steps to the neighbouring tab, wrapping at the ends", () => {
    render(<Chrome />);

    // ⌘⇧[ on macOS; Ctrl+PgUp on Windows/Linux, where the bracket chord is
    // unreliable. From the first tab, previous wraps to the last.
    press(document, isMac ? { code: "BracketLeft", shiftKey: true } : { code: "PageUp" });

    expect(loadRepo).toHaveBeenCalledWith("/third");
  });

  it("returns to the graph on Home, the keyboard twin of the back button", () => {
    const returnToGraph = vi.fn();
    useRepo.setState({ returnToGraph });
    // A stacked review outranks the graph in `deriveCenterView`, so there is
    // something to come back from.
    useUi.setState({ stackedReview: { kind: "commit", oid: "c1", title: "Reviewing" } });
    render(<Chrome />);

    expect(fireEvent.keyDown(document, { code: "Home", key: "Home" })).toBe(false);

    expect(returnToGraph).toHaveBeenCalled();
  });

  it("leaves Home alone when the graph is already showing", () => {
    const returnToGraph = vi.fn();
    useRepo.setState({ returnToGraph });
    render(<Chrome />);

    // Nothing to return from — the key belongs to whatever else wants it.
    expect(fireEvent.keyDown(document, { code: "Home", key: "Home" })).toBe(true);
    expect(returnToGraph).not.toHaveBeenCalled();
  });

  it("switches the view with the shifted digits", () => {
    render(<Chrome />);

    press(document, { code: "Digit2", shiftKey: true });
    expect(useUi.getState().leftTab).toBe("pulls");

    press(document, { code: "Digit1", shiftKey: true });
    expect(useUi.getState().leftTab).toBe("history");
  });

  it("still switches tabs on the missing-repo screen, where there is no toolbar", () => {
    // GL-108: a repo that can't be loaded keeps its tab but renders no toolbar —
    // the keyboard is how you get off a broken tab.
    useRepo.setState({ summary: null, missingRepo: { path: "/repo", kind: "missing" } });
    render(<TitleBar />);

    press(document, { code: "Digit3" });

    expect(loadRepo).toHaveBeenCalledWith("/third");
  });
});

describe("shortcut precedence", () => {
  it("stands down while the user types in a text field", () => {
    render(
      <>
        <ActionBar />
        <textarea data-testid="editor" />
      </>,
    );

    expect(press(screen.getByTestId("editor"), { code: "Enter" })).toBe(true);

    expect(useUi.getState().leftTab).toBe("history");
  });

  it("stands down while a dialog is open", () => {
    render(<ActionBar />);
    useUi.setState({ confirm: { title: "Reset?", onConfirm: () => {} } });

    press(document, { code: "KeyP", shiftKey: true });

    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the terminal its chords but keeps tab switching", () => {
    render(
      <>
        <Chrome />
        <div data-terminal-host>
          {/* xterm focuses a helper <textarea>, so the fixture must be one: a
              plain element would let the text-entry guard hide the bug where
              terminal-safe bindings never ran. */}
          <textarea data-testid="pty" />
        </div>
      </>,
    );
    const pty = screen.getByTestId("pty");

    // A branch shortcut would steal Ctrl+B from the shell.
    expect(press(pty, { code: "KeyB" })).toBe(true);
    expect(useUi.getState().createBranchOpen).toBe(false);

    expect(press(pty, { code: "Digit2" })).toBe(false);
    expect(loadRepo).toHaveBeenCalledWith("/other");

    // The terminal toggle is the other binding that must survive PTY focus.
    expect(press(pty, { code: "KeyT" })).toBe(false);
  });

  it("stands down under the Create PR and agent-message modals", () => {
    render(<Chrome />);

    useUi.setState({ createPrOpen: true });
    press(document, { code: "KeyP", shiftKey: true });
    expect(push).not.toHaveBeenCalled();

    useUi.setState({ createPrOpen: false, agentMessageOpen: true });
    press(document, { code: "KeyP", shiftKey: true });
    expect(push).not.toHaveBeenCalled();
  });

  it("will not push when the toolbar button would be disabled", () => {
    // Nothing to push: the button disables on `!currentSync.canPush`, and the
    // shortcut must obey the same rule rather than starting a publish flow.
    useRepo.setState({
      branches: [
        {
          name: "main",
          kind: "local",
          target: "abc1234",
          isHead: true,
          upstream: "origin/main",
          remote: null,
          sync: { status: "upToDate", upstream: "origin/main", ahead: 0, behind: 0 },
        },
      ],
    });
    render(<Chrome />);

    expect(press(document, { code: "KeyP", shiftKey: true })).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it("lets a disabled binding fall through untouched", () => {
    useRepo.setState({ changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState } });
    render(<ActionBar />);

    // No working changes, so the commit composer binding is inert — and must not
    // swallow the key on its way to whatever else might want it.
    expect(press(document, { code: "Enter" })).toBe(true);
    expect(useUi.getState().leftTab).toBe("history");
  });
});
