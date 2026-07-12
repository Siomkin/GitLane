import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange, TerminalAgent } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { useAccounts } from "@/store/accounts";
import { useIdentities } from "@/store/identities";
import { useTerminalAgents } from "@/store/terminalAgents";
import { useUi } from "@/store/ui";
import { CommitModal } from "./CommitModal";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const staged = (path: string): FileChange => ({ path, status: "M", add: 12, del: 3, binary: false });
const workIdentity = {
  id: "work",
  label: "Work",
  name: "Alex Work",
  email: "alex@work.dev",
  color: "#2563eb",
};
const agent = (over: Partial<TerminalAgent>): TerminalAgent => ({
  id: "claude",
  name: "claude",
  command: "claude",
  description: "",
  enabled: true,
  available: true,
  ...over,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "default_git_identity") return { name: "Alex Global", email: "alex@home.dev" };
    if (command === "repo_identity") return useAccounts.getState().repoIdentity;
    if (command === "set_repo_identity" || command === "clear_repo_identity") return "";
    return { binary: false, hunks: [], truncated: false };
  });
  localStorage.clear();
  localStorage.setItem("gitlane.profiles:v1", JSON.stringify([workIdentity]));
  useAccounts.setState({ repoIdentity: null });
  useIdentities.setState({ manualIdentities: [], defaultIdentity: null });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
    graph: null,
    changes: { staged: [staged("src/features/changes/commit-modal/CommitModal.tsx")], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
  });
  useUi.setState({
    commitOpen: true,
    commitView: "list",
    commitSelFile: null,
    commitCollapsed: {},
    commitExcluded: {},
    commitMsg: "",
  });
  useTerminalAgents.setState({
    agents: [
      agent({ id: "claude", name: "claude", command: "claude" }),
      agent({ id: "codex", name: "codex", command: "codex" }),
    ],
    loading: false,
    error: null,
    loadAgents: vi.fn(async () => {}),
  });
});

describe("CommitModal", () => {
  it("shows the effective commit identity while the dialog is open", async () => {
    render(<CommitModal />);

    expect(await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" })).toBeVisible();
    // Defaults to "This computer" (the global identity) — its picker row is active.
    fireEvent.click(screen.getByRole("button", { name: /^Commit identity:/ }));
    expect(screen.getByRole("button", { name: "Default git identity" })).toHaveAttribute("aria-pressed", "true");
  });

  it("selects a saved identity and displays the reconciled repo identity", async () => {
    render(<CommitModal />);
    await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" });

    fireEvent.click(screen.getByRole("button", { name: /^Commit identity:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));

    expect(await screen.findByRole("button", { name: "Commit identity: Alex Work · alex@work.dev" })).toBeVisible();
    expect(invokeMock).toHaveBeenCalledWith(
      "set_repo_identity",
      expect.objectContaining({ path: "/repo", name: "Alex Work", email: "alex@work.dev" }),
    );
  });

  it("selects This computer and displays the global identity", async () => {
    useAccounts.setState({ repoIdentity: { name: "Alex Work", email: "alex@work.dev" } });
    localStorage.setItem("gitlane.repoCommitSource", JSON.stringify({ "/repo": { kind: "manual", id: "work" } }));
    render(<CommitModal />);
    await screen.findByRole("button", { name: "Commit identity: Alex Work · alex@work.dev" });

    fireEvent.click(screen.getByRole("button", { name: /^Commit identity:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Default git identity" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clear_repo_identity", { path: "/repo" }));
    expect(await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" })).toBeVisible();
  });

  it("blocks commit actions when Git has no usable identity", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "default_git_identity" || command === "repo_identity") return null;
      return { binary: false, hunks: [], truncated: false };
    });
    useUi.setState({ commitMsg: "Commit without identity" });
    render(<CommitModal />);

    expect(await screen.findByRole("button", { name: "Commit identity: Set Git user.name and user.email before committing" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Commit with agent" })).toBeDisabled();
  });

  it("keeps the active identity and shows an error when applying fails", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "default_git_identity") return { name: "Alex Global", email: "alex@home.dev" };
      if (command === "set_repo_identity") throw new Error("permission denied");
      return { binary: false, hunks: [], truncated: false };
    });
    render(<CommitModal />);
    await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" });

    fireEvent.click(screen.getByRole("button", { name: /^Commit identity:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Work" }));

    expect(await screen.findByText("Could not apply this identity. The current Git identity is unchanged.")).toBeVisible();
    // The failed apply leaves the effective identity unchanged (still the global one).
    expect(screen.getByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" })).toBeVisible();
  });

  it("allows committing while the global identity is still loading if a repo identity is already set", async () => {
    useAccounts.setState({ repoIdentity: { name: "Alex Work", email: "alex@work.dev" } });
    useUi.setState({ commitMsg: "ready" });
    invokeMock.mockImplementation(async (command: string) => {
      // The global-config read never resolves → the selector stays in "loading",
      // but the pinned repo identity is already usable.
      if (command === "default_git_identity") return new Promise(() => {});
      if (command === "repo_identity") return useAccounts.getState().repoIdentity;
      return { binary: false, hunks: [], truncated: false };
    });
    render(<CommitModal />);

    expect(await screen.findByRole("button", { name: "Commit identity: Alex Work · alex@work.dev" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("updates the displayed identity when repository identity state changes", async () => {
    render(<CommitModal />);
    await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" });

    act(() => useAccounts.setState({ repoIdentity: { name: "External Change", email: "external@example.dev" } }));

    expect(screen.getByRole("button", { name: "Commit identity: External Change · external@example.dev" })).toBeVisible();
  });

  it("resets the ephemeral amend choice when reopened", () => {
    useRepo.setState({
      graph: {
        commits: [
          {
            id: "abc",
            shortId: "abc",
            summary: "Local commit",
            body: "",
            authorName: "Alex",
            authorEmail: "alex@example.com",
            timestamp: 1,
            parents: [],
            lane: 0,
            row: 0,
            color: 0,
            refs: [],
          },
        ],
        edges: [],
        laneCount: 1,
        head: "abc",
        truncated: false,
      },
    });
    render(<CommitModal />);

    fireEvent.click(screen.getByRole("switch", { name: /Add to previous commit/ }));
    expect(screen.getByRole("switch", { name: /Add to previous commit/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    act(() => useUi.setState({ commitOpen: false }));
    act(() => useUi.setState({ commitOpen: true }));

    expect(screen.getByRole("switch", { name: /Add to previous commit/ })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("keeps list view compact", () => {
    const { container } = render(<CommitModal />);

    const dialog = container.querySelector(".w-\\[920px\\]");
    expect(dialog).toHaveClass("h-[560px]", "max-h-[90%]", "max-w-full");
    expect(dialog).not.toHaveClass("w-[1280px]");
  });

  it("uses a larger viewport-bounded shell with a draggable tree pane in tree view", () => {
    useUi.setState({ commitView: "tree" });
    const { container } = render(<CommitModal />);

    const dialog = container.querySelector(".w-\\[1280px\\]");
    expect(dialog).toHaveClass(
      "h-[760px]",
      "max-h-[calc(100vh-4rem)]",
      "max-w-[calc(100vw-4rem)]",
    );

    const treePane = screen.getByTestId("commit-tree-pane");
    expect(treePane).toHaveStyle({ width: "360px" });
    expect(treePane).toHaveClass("rounded-xl", "border", "bg-white", "shadow-sm");
    const treeLayout = container.querySelector(".bg-neutral-50\\/70.p-2");
    expect(treeLayout).toBeTruthy();
    expect(treeLayout).not.toHaveClass("gap-2");
    expect(container.querySelector(".overflow-hidden.rounded-xl.border.border-black\\/5.bg-white.shadow-sm")).toBeTruthy();

    const separator = screen.getByRole("separator", { name: "Resize panels" });
    expect(separator).toHaveClass("mx-1", "w-0.5", "shrink-0");
    expect(separator).not.toHaveClass("border-x");
    expect(separator).not.toHaveClass("-mx-2");

    fireEvent.mouseDown(separator, {
      clientX: 360,
    });
    fireEvent.mouseMove(window, { clientX: 410 });
    fireEvent.mouseUp(window);

    expect(treePane).toHaveStyle({ width: "410px" });
  });

  it("disables commit when an included staged file is guarded", () => {
    useRepo.setState({
      changes: {
        staged: [
          {
            path: "deps/child",
            status: "M",
            add: 0,
            del: 0,
            binary: false,
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        unstaged: [],
        conflicted: [],
        advanced: emptyAdvancedState,
      },
    });
    useUi.setState({ commitMsg: "Update dependency" });

    render(<CommitModal />);

    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(screen.getByText("Submodule: modified files inside submodule. Use the terminal for submodule updates.")).toBeInTheDocument();
  });

  it("opens the selected configured agent when committing with an agent", async () => {
    const sendToTerminal = vi.fn();
    useUi.setState({ sendToTerminal });

    render(<CommitModal />);

    await screen.findByRole("button", { name: "Commit identity: Alex Global · alex@home.dev" });
    // Commit with agent opens the agent popup; picking one commits with it.
    fireEvent.click(screen.getByRole("button", { name: "Commit with agent" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /codex/ }));

    expect(sendToTerminal).toHaveBeenCalledWith(
      "Review the staged changes, write a concise conventional-commit message, and commit them.",
      "codex",
    );
    expect(useUi.getState().commitOpen).toBe(false);
  });

  it("shows the no-agents hint (and no agent button) when no agents are enabled", () => {
    useTerminalAgents.setState({ agents: [], loading: false, error: null, loadAgents: vi.fn(async () => {}) });
    render(<CommitModal />);
    expect(screen.getByText("No enabled agents. Add one in Settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit with agent" })).toBeNull();
  });

  it("disables Commit with agent when no enabled agent is available on PATH", async () => {
    useUi.setState({ commitMsg: "x" });
    useTerminalAgents.setState({
      agents: [agent({ id: "claude", available: false }), agent({ id: "codex", name: "codex", available: false })],
      loading: false,
      error: null,
      loadAgents: vi.fn(async () => {}),
    });
    render(<CommitModal />);
    await screen.findByRole("button", { name: /^Commit identity:/ });
    expect(screen.getByRole("button", { name: "Commit with agent" })).toBeDisabled();
  });

  it("Escape closes an open footer popover without closing the whole modal", async () => {
    render(<CommitModal />);
    fireEvent.click(await screen.findByRole("button", { name: /^Commit identity:/ }));
    expect(screen.getByRole("button", { name: "Default git identity" })).toBeInTheDocument();

    // Escape from within the popover dismisses only the popover (useDismiss
    // captures it), leaving the commit modal open.
    fireEvent.keyDown(screen.getByRole("button", { name: "Default git identity" }), { key: "Escape" });

    expect(screen.queryByRole("button", { name: "Default git identity" })).toBeNull();
    expect(useUi.getState().commitOpen).toBe(true);
  });
});
