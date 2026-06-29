import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileChange } from "../../lib/api";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { CommitModal } from "./CommitModal";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const staged = (path: string): FileChange => ({ path, status: "M", add: 12, del: 3 });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({ binary: false, hunks: [], truncated: false });
  useRepo.setState({
    summary: { path: "/repo", workdir: "/repo", headBranch: "main", headOid: "abc", detached: false },
    graph: null,
    changes: { staged: [staged("src/features/changes/CommitModal.tsx")], unstaged: [], conflicted: [] },
  });
  useUi.setState({
    commitOpen: true,
    commitView: "list",
    commitSelFile: null,
    commitCollapsed: {},
    commitExcluded: {},
    commitMsg: "",
  });
});

describe("CommitModal", () => {
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
            advanced: { kind: "submodule", message: "Submodule: modified files inside submodule" },
          },
        ],
        unstaged: [],
        conflicted: [],
      },
    });
    useUi.setState({ commitMsg: "Update dependency" });

    render(<CommitModal />);

    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(screen.getByText("Submodule: modified files inside submodule. Use the terminal for submodule updates.")).toBeInTheDocument();
  });
});
