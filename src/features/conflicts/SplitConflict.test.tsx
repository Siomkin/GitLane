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

const ONE_CONFLICT = [
  "a",
  "<<<<<<< HEAD",
  "one-ours",
  "=======",
  "one-theirs",
  ">>>>>>> b",
  "end",
  "",
].join("\n");

const regions = parseConflict(TWO_CONFLICTS);
const oneRegion = parseConflict(ONE_CONFLICT);

/** selectionFor with the first conflict (region 1) fully picked = resolved. */
const firstResolved = (idx: number): LineSelection =>
  idx === 1 ? new Set(["a:0"]) : new Set<string>();

function editorForRegions(
  rs: ReturnType<typeof parseConflict>,
  selectionFor: (idx: number) => LineSelection,
) {
  return (
    <SplitConflict
      editor={buildLineEditor(rs, selectionFor)}
      oursSub="main (ours)"
      theirsSub="incoming (theirs)"
      onToggleLine={vi.fn()}
      onSetBlock={vi.fn()}
      onTakeBlock={vi.fn()}
      onSelectAll={vi.fn()}
    />
  );
}

const editorFor = (selectionFor: (idx: number) => LineSelection) =>
  editorForRegions(regions, selectionFor);

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

  it("clamps the active conflict when the count shrinks below it", () => {
    const { rerender } = render(editorFor(firstResolved));
    // Landed on conflict 2 of 2 (region 1 resolved).
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();

    // A refresh re-derives the rows with only one conflict left. The counter and
    // nav must clamp to the surviving hunk, never read "conflict 2 of 1".
    rerender(editorForRegions(oneRegion, () => new Set<string>()));
    expect(screen.getByText(/conflict 1 of 1/)).toBeInTheDocument();
  });

  it("restores the position when the count grows back to include it", () => {
    const { rerender } = render(editorFor(firstResolved));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();

    // Count dips to one (clamped to conflict 1 of 1)...
    rerender(editorForRegions(oneRegion, () => new Set<string>()));
    expect(screen.getByText(/conflict 1 of 1/)).toBeInTheDocument();

    // ...then a hunk re-conflicts and the count returns. The raw index was
    // preserved, so the user lands back on conflict 2 rather than being pinned
    // to the shrunken max.
    rerender(editorFor(() => new Set<string>()));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();
  });

  it("clamps the nav guards, not just the counter, when the count shrinks", () => {
    const { rerender } = render(editorFor(firstResolved));
    // On conflict 2 of 2, Previous is enabled and Next is at the end (disabled).
    expect(screen.getByRole("button", { name: "Previous conflict" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next conflict" })).toBeDisabled();

    // Shrink to one hunk: the active index clamps to 0, so both guards must
    // reflect a single-hunk view (Previous disabled at the start, Next disabled
    // at the end) — never a stale "can go previous" from the raw index.
    rerender(editorForRegions(oneRegion, () => new Set<string>()));
    expect(screen.getByText(/conflict 1 of 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous conflict" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next conflict" })).toBeDisabled();
  });

  it("hides the nav when the file drops to zero conflicts without throwing", () => {
    const { rerender } = render(editorFor(firstResolved));
    expect(screen.getByText(/conflict 2 of 2/)).toBeInTheDocument();

    // Every hunk resolved away (total → 0): the counter/nav block is gated on
    // `total > 0`, so it disappears and nothing reads a negative index.
    rerender(editorForRegions([], () => new Set<string>()));
    expect(screen.queryByText(/conflict \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next conflict" })).not.toBeInTheDocument();
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
