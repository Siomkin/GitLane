// The split editor's lifetime contract (GL-179): on mount it lands on the first
// still-unresolved conflict (counter + reveal); while the same file stays
// mounted, an external refresh that re-derives the rows must not move the
// user's active conflict. The workspace remounts the editor per file (key=path).
import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SplitConflict } from "./SplitConflict";
import { buildLineEditor, parseConflict, type LineSelection } from "./conflictModel";

const scrollSpy = vi.fn();
Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollSpy, writable: true });
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});
vi.stubGlobal("cancelAnimationFrame", () => {});

const TWO_CONFLICTS = [
  "a",
  "<<<<<<< HEAD",
  "one-ours",
  "=======",
  "one-theirs",
  ">>>>>>> b",
  "mid",
  "<<<<<<< HEAD",
  "two-ours",
  "=======",
  "two-theirs",
  ">>>>>>> b",
  "end",
  "",
].join("\n");

const regions = parseConflict(TWO_CONFLICTS);

/** selectionFor with the first conflict (region 1) fully picked = resolved. */
const firstResolved = (idx: number): LineSelection =>
  idx === 1 ? new Set(["a:0"]) : new Set<string>();

function editorFor(selectionFor: (idx: number) => LineSelection) {
  return (
    <SplitConflict
      editor={buildLineEditor(regions, selectionFor)}
      oursSub="main (ours)"
      theirsSub="incoming (theirs)"
      onToggleLine={vi.fn()}
      onSetBlock={vi.fn()}
      onTakeBlock={vi.fn()}
      onSelectAll={vi.fn()}
    />
  );
}

beforeEach(() => {
  scrollSpy.mockClear();
});

describe("SplitConflict — landing lifetime (GL-179)", () => {
  it("lands on the first still-unresolved conflict on mount", () => {
    render(editorFor(firstResolved));
    // Region 1 is resolved → the landing target is the second hunk (region 3),
    // revealed in every pane that shows it.
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();
    const targets = scrollSpy.mock.contexts.map((el) => (el as Element).getAttribute("data-region"));
    expect(targets.length).toBeGreaterThan(0);
    expect(new Set(targets)).toEqual(new Set(["3"]));
  });

  it("keeps the active conflict when rows re-derive while mounted", () => {
    const { rerender } = render(editorFor(firstResolved));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();
    const scrollsAfterMount = scrollSpy.mock.calls.length;

    // External refresh: the first hunk's picks were cleared (both unresolved
    // again). The landing must not re-run — the user stays on conflict 2.
    rerender(editorFor(() => new Set<string>()));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();
    expect(scrollSpy.mock.calls.length).toBe(scrollsAfterMount);
  });

  it("re-lands when remounted for another file", () => {
    render(editorFor(firstResolved));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();

    cleanup();
    render(editorFor(() => new Set<string>()));
    // Fresh mount, nothing resolved → lands on the first conflict.
    expect(screen.getByText(/conflict 1 of 2/)).toBeInTheDocument();
  });
});
