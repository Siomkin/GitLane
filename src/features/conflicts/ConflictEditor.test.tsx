import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { ConflictEditor } from "./ConflictEditor";
import { buildLineEditor, type Region } from "./conflictModel";

type Props = ComponentProps<typeof ConflictEditor>;

// A full prop set for the (otherwise pure) editor; override per test.
const props = (over: Partial<Props> = {}): Props => {
  const regions: Region[] = over.regions ?? [];
  return {
    file: { path: "src/a.ts", kind: "text", deletedSide: "", resolved: false },
    regions,
    binaryContent: false,
    loading: false,
    mode: "inline",
    onMode: vi.fn(),
    decidedCount: 0,
    totalHunks: 0,
    resolved: false,
    malformed: false,
    staged: false,
    decisionFor: () => undefined,
    lineSelFor: () => new Set<string>(),
    oursSub: "current (ours)",
    theirsSub: "incoming (theirs)",
    lineEditor: buildLineEditor(regions, () => new Set<string>()),
    onDecide: vi.fn(),
    onUndo: vi.fn(),
    onToggleLine: vi.fn(),
    onSetBlock: vi.fn(),
    onTakeBlock: vi.fn(),
    onSelectAllSide: vi.fn(),
    onMarkResolved: vi.fn(),
    onUnstage: vi.fn(),
    onAcceptSide: vi.fn(),
    ...over,
  };
};

describe("ConflictEditor", () => {
  it("falls back to the whole-file picker when a text file's content is binary", () => {
    // Regression guard: a file libgit2 calls "text" can return binary content
    // (non-UTF-8); without the fallback the user gets an empty line editor.
    const onAcceptSide = vi.fn();
    render(<ConflictEditor {...props({ binaryContent: true, onAcceptSide })} />);

    // The line-editor resolve footer is gone...
    expect(screen.queryByText(/Mark resolved/i)).not.toBeInTheDocument();
    // ...and the whole-file side picker is shown, wired to ours/theirs.
    fireEvent.click(screen.getByText("Keep current (ours)"));
    expect(onAcceptSide).toHaveBeenCalledWith("ours");
    fireEvent.click(screen.getByText("Take incoming (theirs)"));
    expect(onAcceptSide).toHaveBeenCalledWith("theirs");
  });

  it("shows the line editor for normal (non-binary) text content", () => {
    render(<ConflictEditor {...props({ binaryContent: false })} />);
    expect(screen.getByText(/Mark resolved/i)).toBeInTheDocument();
    expect(screen.queryByText("Keep current (ours)")).not.toBeInTheDocument();
  });

  it("warns and keeps the stage button disabled for malformed markers", () => {
    render(<ConflictEditor {...props({ malformed: true })} />);
    expect(screen.getByText(/markers look malformed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Mark resolved/i })).toBeDisabled();
  });
});
