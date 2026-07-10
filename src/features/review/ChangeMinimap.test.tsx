// Render-level assertions for the change minimap (GL-162 review): bands are
// emitted for contiguous add/del runs, positioned as fractions of the row
// count, and the rail disappears entirely for empty or change-free diffs.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ChangeMinimap } from "./ChangeMinimap";
import type { Tone } from "./diffTones";

const bands = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>(".absolute.inset-x-\\[1px\\]")];

describe("ChangeMinimap", () => {
  it("renders nothing for an empty or change-free tone sequence", () => {
    expect(render(<ChangeMinimap tones={[]} />).container.firstChild).toBeNull();
    expect(
      render(<ChangeMinimap tones={["header", "ctx", "ctx"]} />).container.firstChild,
    ).toBeNull();
  });

  it("merges contiguous same-tone rows into one band, splitting on tone change", () => {
    // rows: header, add, add, ctx, del  →  one add band (len 2), one del band.
    const tones: Tone[] = ["header", "add", "add", "ctx", "del"];
    const { container } = render(<ChangeMinimap tones={tones} />);
    const rendered = bands(container);
    expect(rendered).toHaveLength(2);
    // Positions are fractions of the 5-row sequence: add starts at row 1 (20%),
    // spans 2 rows (40%); del starts at row 4 (80%).
    expect(rendered[0].style.top).toBe("20%");
    expect(rendered[0].style.height).toBe("40%");
    expect(rendered[1].style.top).toBe("80%");
    // Tones color the bands (add green, del red).
    expect(rendered[0].style.background).not.toBe(rendered[1].style.background);
  });
});
