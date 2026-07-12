import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { emptyChanges } from "../../../../store/repoTypes";
import { FileContextMenu } from "./FileContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const realOpenRepoFile = useRepo.getState().openRepoFile;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ text: "hi", size: 2, truncated: false, binary: false });
  useRepo.setState({
    openRepoFile: realOpenRepoFile,
    summary: { path: "/r", workdir: "/r", headBranch: "main", headOid: "c1", detached: false },
    changes: emptyChanges,
    fileView: null,
  });
  useUi.setState({ fileMenu: null, confirm: null });
});

const openMenu = () =>
  useUi.setState({ fileMenu: { x: 10, y: 10, path: "src/App.tsx", discard: { staged: false } } });

describe("FileContextMenu", () => {
  it("renders nothing until a file menu is open", () => {
    const { container } = render(<FileContextMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the file in the center pane and closes the menu", () => {
    const openRepoFile = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ openRepoFile });
    openMenu();
    render(<FileContextMenu />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Open file" }));
    expect(openRepoFile).toHaveBeenCalledWith("src/App.tsx");
    expect(useUi.getState().fileMenu).toBeNull();
  });
});
