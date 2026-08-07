import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRepo } from "@/store/repo";
import { useUi, contextMenuOf, stashMenuOf, tagMenuOf, worktreeMenuOf } from "@/store/ui";
import { BranchRow, StashRow, WorktreeRow } from "./rows";

// Row contract tests (GL-192): each navigator row owns a distinct
// navigation/menu/keyboard contract — locked here against the monolithic
// rows.tsx before the per-row split, and kept green after it.

const realRevealCommit = useRepo.getState().revealCommit;
const realOpenWorktree = useRepo.getState().openWorktree;
const realRevealStash = useRepo.getState().revealStash;

beforeEach(() => {
  useRepo.setState({
    // Pins are stored per repo, so the pin action needs an open repo to key on.
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    revealCommit: realRevealCommit,
    openWorktree: realOpenWorktree,
    revealStash: realRevealStash,
  });
  useUi.setState({
    navOpen: true,
    menu: null,
    draggingFrom: null,
    pinnedNavRefsByRepo: {},
  });
});

const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "" });

describe("BranchRow", () => {
  it("navigates to the ref tip on click and closes the navigator", () => {
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.click(screen.getByText("feature"));

    expect(revealCommit).toHaveBeenCalledWith("abc123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("activates from the keyboard with Enter and Space, preventing the default", () => {
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    const row = screen.getByRole("button", { name: "Reveal local feature" });

    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(revealCommit).toHaveBeenCalledWith("abc123");
    expect(fireEvent.keyDown(row, { key: " " })).toBe(false);
    expect(revealCommit).toHaveBeenCalledTimes(2);
  });

  it("labels the checked-out branch row as current for screen readers", () => {
    render(<BranchRow name="main" kind="local" oid="abc123" isCurrent />);
    expect(screen.getByRole("button", { name: "Current local main" })).toBeInTheDocument();
  });

  it("opens the branch context menu on right-click", () => {
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.contextMenu(screen.getByText("feature"));

    expect(contextMenuOf(useUi.getState())).toMatchObject({ branch: "feature", isCurrent: false });
    expect(tagMenuOf(useUi.getState())).toBeNull();
  });

  it("routes a tag row's right-click to the tag menu, keyed on the tagged oid", () => {
    render(<BranchRow name="v1.0" kind="tag" oid="commit123" refOid="tag123" />);
    fireEvent.contextMenu(screen.getByText("v1.0"));

    expect(tagMenuOf(useUi.getState())).toMatchObject({
      name: "v1.0",
      sha: "commit123",
      refOid: "tag123",
    });
    expect(contextMenuOf(useUi.getState())).toBeNull();
  });

  it("ignores a tag right-click when the oid is unknown", () => {
    render(<BranchRow name="v1.0" kind="tag" />);
    fireEvent.contextMenu(screen.getByText("v1.0"));
    expect(tagMenuOf(useUi.getState())).toBeNull();
    expect(contextMenuOf(useUi.getState())).toBeNull();
  });

  it("drags a local branch as a local ref; tags are not drag sources", () => {
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.dragStart(screen.getByText("feature"), { dataTransfer: dataTransfer() });
    expect(useUi.getState().draggingFrom).toEqual({ name: "feature", kind: "local" });

    // Unmount the first tree before rendering the second — colliding labels
    // between two mounted rows would make the queries ambiguous.
    cleanup();
    useUi.setState({ draggingFrom: null });
    render(<BranchRow name="v1.0" kind="tag" oid="tag123" />);
    fireEvent.dragStart(screen.getByText("v1.0"), { dataTransfer: dataTransfer() });
    expect(useUi.getState().draggingFrom).toBeNull();
  });

  it("reports isCurrent in the context-menu payload for the checked-out branch", () => {
    render(<BranchRow name="main" kind="local" oid="abc123" isCurrent />);
    fireEvent.contextMenu(screen.getByText("main"));
    expect(contextMenuOf(useUi.getState())).toMatchObject({ branch: "main", isCurrent: true });
  });

  it("closes the navigator without navigating when the row has no oid", () => {
    const revealCommit = vi.fn();
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" />);
    fireEvent.click(screen.getByText("feature"));

    expect(revealCommit).not.toHaveBeenCalled();
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("keeps the current-branch glyph even when a worktree name is passed", () => {
    // Glyph precedence: the checked-out branch's check always wins — the
    // worktree marker is only for branches parked in ANOTHER worktree.
    render(<BranchRow name="main" kind="local" oid="abc123" isCurrent worktree="repo-main" />);
    expect(screen.queryByLabelText(/Checked out in worktree/)).not.toBeInTheDocument();
  });

  it("toggles the pin from the hover pin button without navigating", () => {
    const revealCommit = vi.fn();
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.click(screen.getByRole("button", { name: "Pin feature to top" }));

    // The pin key is kind-scoped so a tag named "feature" can't collide.
    expect(useUi.getState().pinnedNavRefsByRepo).toEqual({ "/r": { "local|feature": true } });
    expect(revealCommit).not.toHaveBeenCalled();
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("keeps the pin control outside the row's interactive element", () => {
    // The pin is a sibling of the reveal control, not a child: a real <button>
    // inside role="button" announces as a button within a button. This is the
    // structural guarantee behind the click/drag isolation asserted below.
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    const row = screen.getByRole("button", { name: "Reveal local feature" });
    const pin = screen.getByRole("button", { name: "Pin feature to top" });

    expect(row).not.toContainElement(pin);
    expect(row.querySelector("button")).toBeNull();
    // Both remain reachable — two actions, two tab stops.
    expect(row).toHaveAttribute("tabIndex", "0");
    expect(pin).not.toHaveAttribute("tabIndex", "-1");
  });

  it("does not reveal when the pin is activated from the keyboard", () => {
    const revealCommit = vi.fn();
    useRepo.setState({ revealCommit });

    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Pin feature to top" }), { key: "Enter" });

    expect(revealCommit).not.toHaveBeenCalled();
  });

  it("does not start a ref drag from the pin control", () => {
    // The pin sits inside the row, which is itself a drag source — without an
    // explicit opt-out, dragging the pin would drag the branch.
    render(<BranchRow name="feature" kind="local" oid="abc123" />);
    const pin = screen.getByRole("button", { name: "Pin feature to top" });

    expect(pin).toHaveAttribute("draggable", "false");
    fireEvent.dragStart(pin, { dataTransfer: dataTransfer() });
    expect(useUi.getState().draggingFrom).toBeNull();
  });

  it("keeps pins of one repo out of another", () => {
    // Ref names are not unique across repos: a flat pin map would pin `feature`
    // in every repository that has a branch by that name.
    useUi.setState({ pinnedNavRefsByRepo: { "/other": { "local|feature": true } } });
    render(<BranchRow name="feature" kind="local" oid="abc123" />);

    fireEvent.click(screen.getByRole("button", { name: "Pin feature to top" }));

    expect(useUi.getState().pinnedNavRefsByRepo).toEqual({
      "/other": { "local|feature": true },
      "/r": { "local|feature": true },
    });
  });

  it("ignores a pin toggle when no repo is open", () => {
    useRepo.setState({ summary: null });
    render(<BranchRow name="feature" kind="local" oid="abc123" />);

    fireEvent.click(screen.getByRole("button", { name: "Pin feature to top" }));

    expect(useUi.getState().pinnedNavRefsByRepo).toEqual({});
  });

  it("unpins a pinned row from the same button", () => {
    useUi.setState({ pinnedNavRefsByRepo: { "/r": { "tag|v1.0": true } } });
    render(<BranchRow name="v1.0" kind="tag" oid="tag123" pinned />);
    fireEvent.click(screen.getByRole("button", { name: "Unpin v1.0" }));
    expect(useUi.getState().pinnedNavRefsByRepo).toEqual({ "/r": {} });
  });

  it("shows the sync badge for a local branch and the worktree glyph when parked elsewhere", () => {
    render(
      <BranchRow
        name="feature"
        kind="local"
        oid="abc123"
        sync={{ status: "ahead", upstream: "origin/feature", ahead: 2, behind: 0 }}
        worktree="repo-feature"
      />,
    );
    expect(screen.getByText("↑2")).toBeInTheDocument();
    expect(screen.getByLabelText("Checked out in worktree repo-feature")).toBeInTheDocument();
  });
});

describe("WorktreeRow", () => {
  const wt = { name: "repo-feature", path: "/work/repo-feature", branch: "feature", isMain: false };
  const props = { wt, oid: "abc123", isActive: false, label: "feature" };

  it("reveals the worktree's tip on click and closes the navigator (no app switch)", () => {
    const openWorktree = vi.fn();
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openWorktree, revealCommit });

    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByText("feature"));

    // Same navigate-and-highlight behaviour as the branch rows — switching the
    // app to the worktree lives on the kebab menu now, not the row click.
    expect(revealCommit).toHaveBeenCalledWith("abc123");
    expect(openWorktree).not.toHaveBeenCalled();
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("reveals from the keyboard with Enter and Space, preventing the default", () => {
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ revealCommit });

    render(<WorktreeRow {...props} />);
    const row = screen.getByRole("button", { name: "Reveal worktree feature" });

    // fireEvent returns false when preventDefault was called — Space must not
    // scroll and Enter must not double-fire through native activation.
    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(revealCommit).toHaveBeenCalledTimes(1);
    expect(fireEvent.keyDown(row, { key: " " })).toBe(false);
    expect(revealCommit).toHaveBeenCalledTimes(2);
  });

  it("labels the already-open worktree as current and still reveals its tip on click", () => {
    const revealCommit = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ revealCommit });

    render(<WorktreeRow {...props} isActive />);
    expect(screen.getByRole("button", { name: "Current worktree feature" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("feature"));

    expect(revealCommit).toHaveBeenCalledWith("abc123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("opens the worktree menu from the kebab WITHOUT revealing the row", () => {
    const revealCommit = vi.fn();
    useRepo.setState({ revealCommit });

    render(<WorktreeRow {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Worktree actions for feature" }));

    expect(worktreeMenuOf(useUi.getState())).toMatchObject({
      path: "/work/repo-feature",
      name: "feature",
      isMain: false,
    });
    expect(revealCommit).not.toHaveBeenCalled();
    // The kebab's menu does not close the navigator; only revealing does.
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("stops kebab keyboard events from revealing the row", () => {
    const revealCommit = vi.fn();
    useRepo.setState({ revealCommit });

    render(<WorktreeRow {...props} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Worktree actions for feature" }), {
      key: "Enter",
    });
    expect(revealCommit).not.toHaveBeenCalled();
  });

  it("opens the same worktree menu on right-click", () => {
    render(<WorktreeRow {...props} />);
    fireEvent.contextMenu(screen.getByText("feature"));
    expect(worktreeMenuOf(useUi.getState())).toMatchObject({ path: "/work/repo-feature" });
  });
});

describe("StashRow", () => {
  const stash = {
    index: 0,
    message: "WIP on feature",
    oid: "stash123",
    timestamp: 1,
    baseOid: "base123",
    baseTimestamp: 1,
    context: [],
  };

  it("reveals the stash's graph row on click and closes the navigator", () => {
    const revealStash = vi.fn();
    useRepo.setState({ revealStash });

    render(<StashRow stash={stash} />);
    fireEvent.click(screen.getByText("WIP on feature"));

    expect(revealStash).toHaveBeenCalledWith("stash123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("reveals the stash from the keyboard with Enter, preventing the default", () => {
    const revealStash = vi.fn();
    useRepo.setState({ revealStash });

    render(<StashRow stash={stash} />);
    const row = screen.getByRole("button", { name: "Reveal stash WIP on feature" });

    expect(fireEvent.keyDown(row, { key: "Enter" })).toBe(false);
    expect(revealStash).toHaveBeenCalledWith("stash123");
    expect(useUi.getState().navOpen).toBe(false);
  });

  it("opens the stash menu on right-click, keeping the navigator open", () => {
    render(<StashRow stash={stash} />);
    fireEvent.contextMenu(screen.getByText("WIP on feature"));

    expect(stashMenuOf(useUi.getState())).toMatchObject({ oid: "stash123", message: "WIP on feature" });
    expect(useUi.getState().navOpen).toBe(true);
  });

  it("shows the stash index as the trailing mono badge", () => {
    render(<StashRow stash={stash} />);
    expect(screen.getByText("{0}")).toBeInTheDocument();
  });
});
