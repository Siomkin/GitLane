// RepoGroupContextMenu: the group-wide actions, split out of the tab menu so a
// collapsed group — whose members' tabs are folded away — still has a menu.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MenuKind, repoGroupCollapsed, repoGroupOf, repoNameOf, useUi } from "@/store/ui";
import { RepoGroupContextMenu } from "./RepoGroupContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const ACME = "/dev/acme/frontend";

const openMenuOn = (groupId: string) =>
  useUi.getState().openMenu({ kind: MenuKind.RepoGroup, state: { x: 10, y: 10, groupId } });

/** A group holding one repository, which is also given a custom name so the
 * tests can prove group actions leave the repository's own labels alone. */
const grouped = () => {
  const id = useUi.getState().createRepoGroup("Acme")!;
  useUi.getState().assignRepoGroup(ACME, id);
  useUi.getState().setRepoName(ACME, "Acme · frontend");
  return id;
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
});

describe("RepoGroupContextMenu", () => {
  it("collapses the group, then offers the opposite action", () => {
    const id = grouped();
    openMenuOn(id);
    const view = render(<RepoGroupContextMenu />);

    fireEvent.click(screen.getByText("Collapse group"));
    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(true);

    openMenuOn(id);
    view.rerender(<RepoGroupContextMenu />);
    expect(screen.queryByText("Collapse group")).toBeNull();

    fireEvent.click(screen.getByText("Expand group"));
    expect(repoGroupCollapsed(useUi.getState(), id)).toBe(false);
  });

  it("renames the group without touching its members' own names", () => {
    const id = grouped();
    openMenuOn(id);
    render(<RepoGroupContextMenu />);

    fireEvent.click(screen.getByText("Rename group…"));
    useUi.getState().prompt?.onSubmit("Acme Corp");

    expect(useUi.getState().repoGroups[0]?.name).toBe("Acme Corp");
    expect(repoNameOf(useUi.getState(), ACME)).toBe("Acme · frontend");
  });

  it("deleting the group leaves its repository ungrouped and still named", () => {
    const id = grouped();
    openMenuOn(id);
    render(<RepoGroupContextMenu />);

    fireEvent.click(screen.getByText("Delete group"));

    expect(repoGroupOf(useUi.getState(), ACME)).toBeNull();
    expect(repoNameOf(useUi.getState(), ACME)).toBe("Acme · frontend");
  });

  it("renders nothing for a group that is already gone", () => {
    const id = grouped();
    openMenuOn(id);
    useUi.getState().deleteRepoGroup(id);

    render(<RepoGroupContextMenu />);

    expect(screen.queryByText("Delete group")).toBeNull();
  });
});
