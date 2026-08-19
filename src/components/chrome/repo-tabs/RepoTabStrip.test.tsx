// The grouped tab strip: three repositories all named `frontend` are told apart
// by their group chips, and a group's tabs are drawn together even when the
// stored tab order interleaves another repository between them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { MenuKind, useUi } from "@/store/ui";
import { RepoTabStrip } from "./RepoTabStrip";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const ACME = "/dev/acme/frontend";
const BETA = "/dev/beta/frontend";
const GAMMA = "/dev/gamma/frontend";

beforeEach(() => {
  invokeMock.mockReset();
  useUi.setState({ repoGroups: [], repoLabelsByIdentity: {}, collapsedRepoGroups: [] });
  useRepo.setState({
    openPaths: [],
    summary: null,
    recents: [],
    tabInfoByPath: {},
  });
});

/** Put each path in its own new group, named after its parent directory. */
const groupEach = (paths: Record<string, string>) => {
  for (const [path, groupName] of Object.entries(paths)) {
    useUi.getState().assignRepoGroup(path, useUi.getState().createRepoGroup(groupName));
  }
};

describe("RepoTabStrip", () => {
  it("distinguishes same-named repositories by their group chips", () => {
    useRepo.setState({ openPaths: [ACME, BETA, GAMMA] });
    groupEach({ [ACME]: "Acme", [BETA]: "Beta", [GAMMA]: "Gamma" });

    render(<RepoTabStrip />);

    expect(screen.getAllByText("frontend")).toHaveLength(3);
    for (const name of ["Acme", "Beta", "Gamma"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("draws a group's tabs together when another repository sits between them", () => {
    useRepo.setState({ openPaths: [ACME, "/dev/notes", BETA] });
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME, acme);
    useUi.getState().assignRepoGroup(BETA, acme);

    render(<RepoTabStrip />);

    const run = document.querySelector('[data-group]') as HTMLElement;
    expect(within(run).getByText("Acme")).toBeInTheDocument();
    // Both members live inside the group's run; the ungrouped tab does not.
    expect(within(run).getAllByTitle(/frontend/)).toHaveLength(2);
    expect(within(run).queryByTitle("/dev/notes")).toBeNull();
  });

  it("shows a repository's custom name in place of its folder name", () => {
    useRepo.setState({ openPaths: [ACME] });
    useUi.getState().setRepoName(ACME, "Acme · frontend");

    render(<RepoTabStrip />);

    expect(screen.getByText("Acme · frontend")).toBeInTheDocument();
    expect(screen.queryByText("frontend")).toBeNull();
  });

  it("keeps an ungrouped tab outside the group's cluster it sits beside", () => {
    // The bug this guards: an ungrouped tab drawn flush against a group reads
    // as a member of it. The group's cluster is its own bordered element, so
    // "next to" and "inside" are different DOM positions, not just spacing.
    useRepo.setState({ openPaths: [ACME, "/dev/notes"] });
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME, acme);

    render(<RepoTabStrip />);

    const cluster = document.querySelector("[data-group]") as HTMLElement;
    expect(within(cluster).getByTitle(ACME)).toBeInTheDocument();
    expect(within(cluster).queryByTitle("/dev/notes")).toBeNull();
    expect(screen.getByTitle("/dev/notes")).toBeInTheDocument();
  });

});

describe("collapsing a group", () => {
  /** Put both Acme paths in one group and return its id. */
  const acmeGroup = () => {
    const id = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().assignRepoGroup(ACME, id);
    useUi.getState().assignRepoGroup(BETA, id);
    return id;
  };

  /** Collapse the group the way the app does — the tab context menu's
   * `Collapse group`, i.e. the store action. Expanding is the pill's own
   * chevron, which the tests click directly. */
  const collapse = (id: string) => act(() => useUi.getState().toggleRepoGroupCollapsed(id));

  it("folds the group's tabs away behind a pill carrying its count", () => {
    useRepo.setState({ openPaths: [ACME, "/dev/notes", BETA], summary: null });
    const id = acmeGroup();

    render(<RepoTabStrip />);
    collapse(id);

    // Only the ungrouped tab is left drawn; the pill counts both members.
    expect(screen.queryAllByTitle(/frontend/)).toHaveLength(0);
    expect(screen.getByTitle("/dev/notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Expand group Acme, 2 tabs/ })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("restores the tabs, in order, when expanded again", () => {
    useRepo.setState({ openPaths: [ACME, BETA], summary: null });
    const id = acmeGroup();

    render(<RepoTabStrip />);
    collapse(id);
    fireEvent.doubleClick(screen.getByRole("button", { name: /Expand group Acme/ }));

    const run = document.querySelector("[data-group]") as HTMLElement;
    expect(within(run).getAllByTitle(/frontend/).map((el) => el.getAttribute("title"))).toEqual([
      ACME,
      BETA,
    ]);
  });

  it("collapses on a double-click of the group name", () => {
    useRepo.setState({ openPaths: [ACME, BETA], summary: null });
    acmeGroup();

    render(<RepoTabStrip />);
    fireEvent.doubleClick(screen.getByText("Acme"));

    expect(screen.getByRole("button", { name: /Expand group Acme, 2 tabs/ })).toBeInTheDocument();
    expect(screen.queryAllByTitle(/frontend/)).toHaveLength(0);
  });

  it("expands again on a double-click of the pill", () => {
    useRepo.setState({ openPaths: [ACME, BETA], summary: null });
    const id = acmeGroup();
    collapse(id);

    render(<RepoTabStrip />);
    fireEvent.doubleClick(screen.getByRole("button", { name: /Expand group Acme/ }));

    expect(screen.getAllByTitle(/frontend/)).toHaveLength(2);
  });

  it("ignores a single mouse click on the pill, but not keyboard activation", () => {
    useRepo.setState({ openPaths: [ACME], summary: null });
    const id = acmeGroup();
    collapse(id);

    render(<RepoTabStrip />);
    const pill = screen.getByRole("button", { name: /Expand group Acme/ });

    // A single mouse click must not expand, or the press that starts a drag
    // would toggle the group on release.
    fireEvent.click(pill);
    expect(useUi.getState().collapsedRepoGroups).toEqual([id]);

    fireEvent.keyDown(pill, { key: "Enter" });
    expect(useUi.getState().collapsedRepoGroups).toEqual([]);
  });

  it("keeps the pill out of the tags dnd-kit refuses to drag from", () => {
    useRepo.setState({ openPaths: [ACME], summary: null });
    const id = acmeGroup();
    collapse(id);

    render(<RepoTabStrip />);
    const pill = screen.getByRole("button", { name: /Expand group Acme/ });

    // dnd-kit's pointer sensor blocks a drag that starts on a nested
    // interactive element, matched by TAG (`button`, `a[href]`, inputs) rather
    // than by role — so a real <button> here makes a collapsed group
    // undraggable. See `getInteractiveElement` in @dnd-kit/dom.
    expect(pill.tagName).toBe("DIV");
    expect(pill).toHaveAttribute("tabindex", "0");
  });

  it("raises the group menu on right-click, collapsed or not", () => {
    useRepo.setState({ openPaths: [ACME], summary: null });
    const id = acmeGroup();

    render(<RepoTabStrip />);
    fireEvent.contextMenu(screen.getByText("Acme"), { clientX: 4, clientY: 8 });
    expect(useUi.getState().menu).toEqual({
      kind: MenuKind.RepoGroup,
      state: { x: 4, y: 8, groupId: id },
    });

    collapse(id);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Expand group Acme/ }));
    expect(useUi.getState().menu?.kind).toBe(MenuKind.RepoGroup);
  });

  it("keeps drawing the active tab a collapsed group holds", () => {
    useRepo.setState({
      openPaths: [ACME, BETA],
      summary: { path: BETA } as never,
    });
    const id = acmeGroup();

    render(<RepoTabStrip />);
    collapse(id);

    // The active tab stays visible; its sibling folds away. The count still
    // reports the whole group.
    expect(screen.getByTitle(BETA)).toBeInTheDocument();
    expect(screen.queryByTitle(ACME)).toBeNull();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("folds away completely once the active tab moves out of the group", () => {
    useRepo.setState({
      openPaths: [ACME, BETA, "/dev/notes"],
      summary: { path: BETA } as never,
    });
    const id = acmeGroup();

    const { rerender } = render(<RepoTabStrip />);
    collapse(id);
    expect(screen.getByTitle(BETA)).toBeInTheDocument();

    // The user activates the ungrouped repository.
    useRepo.setState({ summary: { path: "/dev/notes" } as never });
    rerender(<RepoTabStrip />);

    expect(screen.queryByTitle(BETA)).toBeNull();
    expect(screen.getByRole("button", { name: /Expand group Acme/ })).toBeInTheDocument();
  });

});

describe("RepoTabStrip", () => {
  it("renders plain tabs with no chip when nothing is grouped", () => {
    useRepo.setState({ openPaths: [ACME, BETA] });

    render(<RepoTabStrip />);

    expect(document.querySelector("[data-group]")).toBeNull();
    expect(screen.getAllByText("frontend")).toHaveLength(2);
  });
});
