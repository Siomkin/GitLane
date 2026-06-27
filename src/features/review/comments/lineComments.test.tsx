import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiffHunk } from "../../../lib/api";
import { useUi } from "../../../store/ui";
import { UnifiedDiffBody } from "../DiffBody";
import { HandToAgentBar } from "./HandToAgentBar";

const hunks: DiffHunk[] = [
  {
    header: "@@ -1,2 +1,3 @@",
    lines: [
      { kind: "ctx", oldNo: 1, newNo: 1, content: "context" },
      { kind: "add", oldNo: null, newNo: 2, content: "added line" },
    ],
  },
];

beforeEach(() => useUi.getState().clearReviewNotes());
afterEach(() => useUi.getState().clearReviewNotes());

describe("in-diff local comments", () => {
  it("opens a comment from a line handle and pins it to the store", () => {
    render(<UnifiedDiffBody hunks={hunks} file="a.ts" />);
    expect(screen.getByText("@@ -1,2 +1,3 @@")).toBeInTheDocument();

    // Click the added line's handle (release commits the single-line range).
    const handles = screen.getAllByTitle("Click, or drag down, to comment on line(s)");
    fireEvent.mouseDown(handles[handles.length - 1]);
    fireEvent.mouseUp(document);

    const editor = screen.getByPlaceholderText(/Request change/);
    expect(screen.getByText(/Comment on line R2/)).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "please fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    // Saved to the store as a single-line range; editor closes.
    expect(useUi.getState().reviewNotes).toHaveLength(1);
    expect(useUi.getState().reviewNotes[0].lineRef).toBe("R2");
    expect(screen.queryByPlaceholderText(/Request change/)).toBeNull();

    // The line is now an anchor; expanding the marker shows the saved card.
    fireEvent.click(screen.getByRole("button", { name: "Toggle comment" }));
    expect(screen.getByText("please fix")).toBeInTheDocument();
    expect(screen.getAllByText("Local comment").length).toBeGreaterThan(0);
  });

  it("HandToAgentBar surfaces the pending count and opens the composer", () => {
    useUi.getState().addReviewNote({
      file: "a.ts",
      side: "R",
      line: 2,
      fromRef: "R2",
      toRef: "R2",
      lineRef: "R2",
      code: "added line",
      body: "x",
    });
    render(<HandToAgentBar />);
    expect(screen.getByText("Hand to agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare message for agent" }));
    expect(useUi.getState().agentMessageOpen).toBe(true);
  });
});
