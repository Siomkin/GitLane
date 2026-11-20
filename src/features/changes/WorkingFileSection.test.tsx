import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { FileChange, WorkingChanges } from "@/lib/api";
import { FileListView } from "./file-list";
import { FileSection } from "./WorkingFileSection";

const file = (path: string, over: Partial<FileChange> = {}): FileChange => ({
  path,
  status: "M",
  add: 1,
  del: 0,
  binary: false,
  ...over,
});

describe("FileSection folder guard", () => {
  it("blocks only the folder holding a guarded file", () => {
    const files = [
      file("lib/sub", { advanced: { kind: "submodule", message: "Submodule lib/sub" } }),
      file("lib/other.ts"),
      file("src/a.ts"),
      file("src/b.ts"),
    ];
    const changes: WorkingChanges = { staged: [], unstaged: files, conflicted: [], advanced: emptyAdvancedState };
    const onDirAction = vi.fn();
    render(
      <FileSection
        title="Unstaged"
        files={files}
        totalCount={files.length}
        view={FileListView.Tree}
        selectedPath={null}
        tone="stage"
        allLabel="Stage all"
        onAll={() => {}}
        changes={changes}
        onAction={() => {}}
        onDirAction={onDirAction}
        onSelect={() => {}}
        onContextMenu={() => {}}
        onDirContextMenu={() => {}}
        menuPath={null}
      />,
    );
    const lib = screen.getByText("lib").closest(".group")!.querySelector("button[aria-label='Stage']")!;
    const src = screen.getByText("src").closest(".group")!.querySelector("button[aria-label='Stage']")!;
    expect(lib).toBeDisabled();
    expect(lib.getAttribute("title")).toContain("Submodule lib/sub");
    expect(src).toBeEnabled();
  });
});
