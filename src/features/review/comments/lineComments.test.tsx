import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffHunk } from "@/lib/api";
import { useUi } from "@/store/ui";
import { UnifiedDiffBody } from "@/features/review/DiffBody";
import { HandToAgentBar } from "./HandToAgentBar";
import { useMultiFileLineComments } from "./useLineComments";
import type { LineMeta } from "./notes";

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
    render(<UnifiedDiffBody hunks={hunks} file="a.ts" surface="work" />);
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
    expect(useUi.getState().reviewNotes[0].surface).toBe("work");
    expect(screen.queryByPlaceholderText(/Request change/)).toBeNull();

    // The line is now an anchor; expanding the marker shows the saved card.
    fireEvent.click(screen.getByRole("button", { name: "Toggle comment" }));
    expect(screen.getByText("please fix")).toBeInTheDocument();
    expect(screen.getAllByText("Local comment").length).toBeGreaterThan(0);
  });

  it("does not attach a note from a different surface", () => {
    // Same file + ref, but pinned to another diff surface (a specific commit).
    useUi.getState().addReviewNote({
      surface: "commit:other",
      file: "a.ts",
      side: "R",
      line: 2,
      fromRef: "R2",
      toRef: "R2",
      lineRef: "R2",
      code: "added line",
      body: "x",
    });
    render(<UnifiedDiffBody hunks={hunks} file="a.ts" surface="work" />);
    // The note belongs to another surface, so no anchor marker is rendered here.
    expect(screen.queryByRole("button", { name: "Toggle comment" })).toBeNull();
  });

  it("keeps stacked-review comments file-scoped across eviction and reload", () => {
    const line = (code: string): LineMeta[] => [
      { seq: 0, side: "R", lineNo: 1, ref: "R1", code },
    ];
    const loaded = new Map([
      ["a.ts", line("from a")],
      ["b.ts", line("from b")],
    ]);
    const { result, rerender } = renderHook(
      ({ linesByFile }: { linesByFile: ReadonlyMap<string, LineMeta[]> }) =>
        useMultiFileLineComments("commit:c1", linesByFile),
      { initialProps: { linesByFile: loaded } },
    );
    const mouseEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    act(() => {
      result.current
        .controllerFor("a.ts")
        .rowFor(0)
        .onHandleDown(mouseEvent as never);
    });
    fireEvent.mouseUp(document);

    expect(result.current.controllerFor("a.ts").rowFor(0).editHere).toBe(true);
    expect(result.current.controllerFor("b.ts").rowFor(0).editHere).toBe(false);

    act(() => result.current.controllerFor("a.ts").setDraft("fix file a"));
    act(() => result.current.controllerFor("a.ts").save());
    expect(useUi.getState().reviewNotes).toMatchObject([
      { surface: "commit:c1", file: "a.ts", body: "fix file a" },
    ]);
    expect(result.current.controllerFor("a.ts").rowFor(0).isAnchor).toBe(true);
    expect(result.current.controllerFor("b.ts").rowFor(0).isAnchor).toBe(false);

    // Eviction removes the file's line metadata, not its durable note. Reloading
    // the same diff resolves the saved refs and restores the anchor.
    rerender({ linesByFile: new Map([["b.ts", line("from b")]]) });
    expect(result.current.controllerFor("a.ts").rowFor(0).isAnchor).toBe(false);
    rerender({ linesByFile: loaded });
    expect(result.current.controllerFor("a.ts").rowFor(0)).toMatchObject({
      isAnchor: true,
      body: "fix file a",
    });
  });

  it("isolates repeated-path controllers while persisting the real file path", () => {
    const lines: LineMeta[] = [
      { seq: 0, side: "R", lineNo: 1, ref: "R1", code: "same path" },
    ];
    const linesByFile = new Map([
      ["occurrence:1", lines],
      ["occurrence:2", lines],
    ]);
    const noteFileForKey = () => "src/repeated.ts";
    const { result } = renderHook(() =>
      useMultiFileLineComments("pr:42", linesByFile, { noteFileForKey }),
    );
    const mouseEvent = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    act(() => {
      result.current
        .controllerFor("occurrence:1")
        .rowFor(0)
        .onHandleDown(mouseEvent as never);
    });
    fireEvent.mouseUp(document);
    act(() => result.current.controllerFor("occurrence:1").setDraft("fix both views"));
    act(() => result.current.controllerFor("occurrence:1").save());

    expect(useUi.getState().reviewNotes).toMatchObject([
      { surface: "pr:42", file: "src/repeated.ts", body: "fix both views" },
    ]);
    expect(result.current.controllerFor("occurrence:1").rowFor(0).isAnchor).toBe(true);
    expect(result.current.controllerFor("occurrence:2").rowFor(0).isAnchor).toBe(true);
  });

  it("HandToAgentBar surfaces the pending count and opens the composer", () => {
    useUi.getState().addReviewNote({
      surface: "work",
      file: "a.ts",
      side: "R",
      line: 2,
      fromRef: "R2",
      toRef: "R2",
      lineRef: "R2",
      code: "added line",
      body: "x",
    });
    render(<HandToAgentBar surfaces={["work"]} />);
    expect(screen.getByText("Hand to agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare message for agent" }));
    expect(useUi.getState().agentMessageOpen).toBe(true);
  });
});
