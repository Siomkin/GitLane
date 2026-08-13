// The inline editor's lifetime contract (GL-179): the scroll-to-first-undecided
// landing runs once per mounted file. The workspace remounts the editor per file
// (key=path), so switching files re-lands; an external content refresh while the
// same file stays mounted must NOT yank the user back to the first conflict.
import { cleanup, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InlineConflict } from "./InlineConflict";
import { parseConflict, type RegionDecision } from "./conflictModel";

// jsdom lacks scrollIntoView and its rAF is timer-driven — make both observable
// and synchronous so the landing scroll is assertable.
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

function editor(decisionFor: (idx: number) => RegionDecision | undefined) {
  return (
    <InlineConflict
      regions={regions}
      oursSub="main (ours)"
      theirsSub="incoming (theirs)"
      decisionFor={decisionFor}
      lineSelFor={() => new Set<string>()}
      customFor={() => undefined}
      onDecide={vi.fn()}
      onUndo={vi.fn()}
    />
  );
}

/** The region index the last landing scroll targeted. */
const lastTarget = () => {
  const contexts = scrollSpy.mock.contexts;
  const el = contexts[contexts.length - 1] as Element;
  return el.getAttribute("data-region");
};

beforeEach(() => {
  scrollSpy.mockClear();
});

describe("InlineConflict — landing scroll lifetime (GL-179)", () => {
  it("scrolls to the first undecided conflict on mount", () => {
    // First conflict (region 1) already decided → land on region 3.
    render(editor((idx) => (idx === 1 ? "ours" : undefined)));

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(lastTarget()).toBe("3");
  });

  it("does not re-target when content refreshes while the file stays mounted", () => {
    const { rerender } = render(editor(() => undefined));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(lastTarget()).toBe("1");

    // A watcher refresh re-derives decisions (here: the first hunk got decided
    // externally). The user's scroll position must be left alone.
    rerender(editor((idx) => (idx === 1 ? "theirs" : undefined)));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("re-runs the landing scroll when remounted for another file", () => {
    render(editor(() => undefined));
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // The workspace remounts the editor per file via key=path.
    cleanup();
    render(editor(() => undefined));
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });
});
