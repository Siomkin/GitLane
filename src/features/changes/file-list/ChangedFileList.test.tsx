import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileChange } from "@/lib/api";
import { ChangedFileList } from "./ChangedFileList";

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
    render(<ChangedFileList files={files} view="path" activePath={null} onSelect={onSelect} />);
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("Foo.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
    await user.click(screen.getByText("app.ts"));
    expect(onSelect).toHaveBeenCalledWith("src/app.ts");
  });

  it("tree mode groups files under directory headers and still selects a leaf", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ChangedFileList files={files} view="tree" activePath={null} onSelect={onSelect} />);
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
    render(<ChangedFileList files={files} view="tree" activePath={null} onSelect={() => {}} />);
    expect(screen.getByText("Foo.tsx")).toBeInTheDocument();
    await user.click(screen.getByText("ui"));
    expect(screen.queryByText("Foo.tsx")).not.toBeInTheDocument();
  });

  it("renders a per-file stage action in tree mode and fires it without selecting", async () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(
      <ChangedFileList
        files={[file("src/app.ts")]}
        view="tree"
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
        view="tree"
        activePath={null}
        compact={false}
        onSelect={() => {}}
        dirAction={(paths) => ({ tone: "unstage", onAction: () => onDir(paths) })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Unstage" }));
    expect(onDir).toHaveBeenCalledWith(["src/ui/Bar.tsx", "src/ui/Foo.tsx"]);
  });
});
