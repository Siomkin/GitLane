import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileChange } from "@/lib/api";
import { ChangedFileList } from "./ChangedFileList";
import { FileListView } from "./types";

const file = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  ...over,
});

const files = [
  file("README.md"),
  file("src/app.ts"),
  file("src/ui/Bar.tsx"),
  file("src/ui/Foo.tsx"),
];

describe("ChangedFileList", () => {
  it("path mode lists every file and fires onSelect with the path", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ChangedFileList files={files} view={FileListView.Path} activePath={null} onSelect={onSelect} />);
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("Foo.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    await user.click(screen.getByText("app.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/app.ts");
  });

  it("tree mode groups files under directory headers and still selects a leaf", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ChangedFileList files={files} view={FileListView.Tree} activePath={null} onSelect={onSelect} />);
    // `src` holds a direct file (app.ts) so it stays its own header, and `ui`
    // nests one level deeper.
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("ui")).toBeInTheDocument();
    expect(screen.getByText("Foo.tsx")).toBeInTheDocument();
    await user.click(screen.getByText("Foo.tsx"));
    expect(onSelect).toHaveBeenCalledWith("src/ui/Foo.tsx");
  });

  it("collapses a directory's files when its header is clicked", async () => {
    const user = userEvent.setup();
    render(<ChangedFileList files={files} view={FileListView.Tree} activePath={null} onSelect={() => {}} />);
    expect(screen.getByText("Foo.tsx")).toBeInTheDocument();
    await user.click(screen.getByText("ui"));
    expect(screen.queryByText("Foo.tsx")).not.toBeInTheDocument();
  });

  it("fires onDirContextMenu with the folder's full path on right-click", () => {
    const onDirContextMenu = vi.fn();
    render(
      <ChangedFileList
        files={files}
        view={FileListView.Tree}
        activePath={null}
        onSelect={() => {}}
        onDirContextMenu={onDirContextMenu}
      />,
    );
    // `ui` nests under `src`, so its header carries the full repo-relative path.
    fireEvent.contextMenu(screen.getByText("ui"));
    expect(onDirContextMenu).toHaveBeenCalledTimes(1);
    expect(onDirContextMenu.mock.calls[0][0]).toBe("src/ui");
  });

  it("renders a per-file stage action in tree mode and fires it without selecting", async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ChangedFileList
        files={[file("src/app.ts")]}
        view={FileListView.Tree}
        activePath={null}
        compact={false}
        onSelect={onSelect}
        rowAction={() => ({ tone: "stage", onAction })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Stage" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a folder roll-up action that fires with every path under the directory", async () => {
    const onDir = vi.fn();
    const user = userEvent.setup();
    render(
      <ChangedFileList
        files={[file("src/ui/Bar.tsx"), file("src/ui/Foo.tsx")]}
        view={FileListView.Tree}
        activePath={null}
        compact={false}
        onSelect={() => {}}
        dirAction={(paths) => ({ tone: "unstage", onAction: () => onDir(paths) })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Unstage" }));
    expect(onDir).toHaveBeenCalledWith(["src/ui/Bar.tsx", "src/ui/Foo.tsx"]);
  });

  describe("arrow-key navigation (GL-346)", () => {
    const list = (view: FileListView, activePath: string | null, onSelect: () => void) =>
      render(
        <ChangedFileList files={files} view={view} activePath={activePath} onSelect={onSelect} />,
      ).container.firstElementChild as HTMLElement;

    it("moves down and up one file in path mode", () => {
      const onSelect = vi.fn();
      const container = list(FileListView.Path, "src/app.ts", onSelect);

      fireEvent.keyDown(container, { key: "ArrowDown" });
      expect(onSelect).toHaveBeenLastCalledWith("src/ui/Bar.tsx");

      fireEvent.keyDown(container, { key: "ArrowUp" });
      expect(onSelect).toHaveBeenLastCalledWith("README.md");
    });

    it("walks files in tree mode, skipping directory headers", () => {
      const onSelect = vi.fn();
      // Tree order puts directories before files (commitTree), so the rows read
      // src/ui/Bar.tsx, src/ui/Foo.tsx, src/app.ts, README.md.
      const container = list(FileListView.Tree, "src/ui/Foo.tsx", onSelect);

      // Leaving the `ui` group steps straight to the next file, not onto the
      // `src` header row.
      fireEvent.keyDown(container, { key: "ArrowDown" });

      expect(onSelect).toHaveBeenLastCalledWith("src/app.ts");
    });

    it("enters the list from the near end when nothing is active", () => {
      const onSelect = vi.fn();
      const container = list(FileListView.Path, null, onSelect);

      fireEvent.keyDown(container, { key: "ArrowUp" });

      expect(onSelect).toHaveBeenLastCalledWith("src/ui/Foo.tsx");
    });

    it("stops at the ends and leaves other keys alone", () => {
      const onSelect = vi.fn();
      const container = list(FileListView.Path, "README.md", onSelect);

      fireEvent.keyDown(container, { key: "ArrowUp" });
      expect(onSelect).not.toHaveBeenCalled();

      fireEvent.keyDown(container, { key: "ArrowLeft" });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("keeps focus on the list so no clipped focus ring appears on the row", () => {
      const container = list(FileListView.Path, "README.md", vi.fn());
      container.focus();

      fireEvent.keyDown(container, { key: "ArrowDown" });

      expect(document.activeElement).toBe(container);
    });
  });
});
