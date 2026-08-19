// RepoTabContextMenu: what the menu offers depends on whether the repository
// is named and grouped — and renaming lands on the repository *identity*, so a
// worktree tab renames its parent repository.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRepo } from "@/store/repo";
import { MenuKind, repoGroupOf, repoNameOf, useUi } from "@/store/ui";
import { RepoTabContextMenu } from "./RepoTabContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const ACME = "/dev/acme/frontend";
const WORKTREE = "/dev/acme/frontend-wt-feat";

const openMenuOn = (path: string) =>
  useUi.getState().openMenu({ kind: MenuKind.RepoTab, state: { x: 10, y: 10, path } });

/** Submit the open prompt dialog's value, the way the dialog's onSubmit does. */
const submitPrompt = (value: string) => {
  const prompt = useUi.getState().prompt;
  expect(prompt).not.toBeNull();
  prompt?.onSubmit(value);
};

beforeEach(() => {
  invokeMock.mockReset();
  useUi.setState({
    repoGroups: [],
    repoLabelsByIdentity: {},
    collapsedRepoGroups: [],
    menu: null,
    prompt: null,
  });
  useRepo.setState({ openPaths: [ACME], tabInfoByPath: {} });
});

describe("RepoTabContextMenu", () => {
  it("renames the repository from the tab", () => {
    openMenuOn(ACME);
    render(<RepoTabContextMenu />);

    fireEvent.click(screen.getByText("Rename…"));
    submitPrompt("Acme · frontend");

    expect(repoNameOf(useUi.getState(), ACME)).toBe("Acme · frontend");
  });

  it("renames the parent repository from a worktree tab", () => {
    useRepo.setState({
      openPaths: [WORKTREE],
      tabInfoByPath: { [WORKTREE]: { isWorktree: true, mainPath: ACME, branch: "feat" } },
    });
    openMenuOn(WORKTREE);
    render(<RepoTabContextMenu />);

    fireEvent.click(screen.getByText("Rename…"));
    submitPrompt("Acme");

    expect(repoNameOf(useUi.getState(), ACME)).toBe("Acme");
  });

  it("hides the group-only actions for an ungrouped repository", () => {
    openMenuOn(ACME);
    render(<RepoTabContextMenu />);

    expect(screen.getByText("Assign to group")).toBeInTheDocument();
    expect(screen.queryByText("Remove from group")).toBeNull();
    // Group-wide actions live in the group menu, never here.
    expect(screen.queryByText("Delete group")).toBeNull();
    expect(screen.queryByText("Rename group…")).toBeNull();
    expect(screen.queryByText("Collapse group")).toBeNull();
    // Nothing to revert to while the folder name is what's shown.
    expect(screen.queryByText("Use folder name")).toBeNull();
  });

  it("creates a group and puts the repository in it", () => {
    openMenuOn(ACME);
    render(<RepoTabContextMenu />);

    fireEvent.click(screen.getByText("Assign to group"));
    fireEvent.click(screen.getByText("New group…"));
    submitPrompt("Acme");

    expect(repoGroupOf(useUi.getState(), ACME)?.name).toBe("Acme");
  });

  it("omits the current group from the assign list and offers leaving it", () => {
    const acme = useUi.getState().createRepoGroup("Acme")!;
    useUi.getState().createRepoGroup("Personal")!;
    useUi.getState().assignRepoGroup(ACME, acme);

    openMenuOn(ACME);
    render(<RepoTabContextMenu />);

    fireEvent.click(screen.getByText("Group: Acme"));
    expect(screen.getByText("Personal")).toBeInTheDocument();
    // "Acme" appears only as the current-group row, not as a target.
    expect(screen.getAllByText(/Acme/)).toHaveLength(1);

    fireEvent.click(screen.getByText("Remove from group"));
    expect(repoGroupOf(useUi.getState(), ACME)).toBeNull();
  });

  it("clears a custom name back to the folder name", () => {
    useUi.getState().setRepoName(ACME, "Acme · frontend");
    openMenuOn(ACME);
    render(<RepoTabContextMenu />);

    fireEvent.click(screen.getByText("Use folder name"));
    expect(repoNameOf(useUi.getState(), ACME)).toBeNull();
  });

});
