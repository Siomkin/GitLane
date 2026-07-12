import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Language } from "@/lib/highlight";
import { FileSourceView } from "./FileSourceView";
import { computeLineChanges } from "./lineChanges";

describe("FileSourceView change bars", () => {
  it("paints uncommitted-change bars against the baseline in read-only view", () => {
    const changes = computeLineChanges(["a", "b", "c"], ["a", "B!", "c"]); // line 2 modified
    const { container } = render(
      <FileSourceView
        shownLines={["a", "B!", "c"]}
        totalLines={3}
        maxRenderLines={20000}
        lang={Language.Generic}
        changes={changes}
      />,
    );
    // The change bar is the only span painted with a `background` (syntax tokens
    // use `color`), so its presence proves the modified line is decorated.
    const bars = container.querySelectorAll('span[style*="background"]');
    expect(bars.length).toBe(1);
  });

  it("renders an EOF deletion caret when the last committed line was removed", () => {
    // Baseline had a trailing line that the working copy dropped.
    const changes = computeLineChanges(["a", "b", "c"], ["a", "b"]);
    expect(changes.deletedAtEnd).toBe(true);
    const { container } = render(
      <FileSourceView
        shownLines={["a", "b"]}
        totalLines={2}
        maxRenderLines={20000}
        lang={Language.Generic}
        changes={changes}
      />,
    );
    // The caret is a zero-size triangle drawn with a top border (not a background).
    const carets = container.querySelectorAll('span[style*="border-top"]');
    expect(carets.length).toBe(1);
  });

  it("paints no bars when there are no changes", () => {
    const { container } = render(
      <FileSourceView
        shownLines={["a", "b"]}
        totalLines={2}
        maxRenderLines={20000}
        lang={Language.Generic}
        changes={computeLineChanges(["a", "b"], ["a", "b"])}
      />,
    );
    expect(container.querySelectorAll('span[style*="background"]').length).toBe(0);
  });
});
