import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { HighlightMatch } from "./HighlightMatch";

// Render the component and return its host element so we can inspect text + marks.
const mount = (text: string, query: string) => {
  const { container } = render(<HighlightMatch text={text} query={query} />);
  return container;
};
const marks = (c: HTMLElement) => Array.from(c.querySelectorAll("mark")).map((m) => m.textContent);

describe("HighlightMatch", () => {
  it("renders plain text (no <mark>) when the query is under 3 chars", () => {
    for (const q of ["", "  ", "a", "ab", " ab "]) {
      const c = mount("alpha beta", q);
      expect(c.textContent).toBe("alpha beta");
      expect(marks(c)).toHaveLength(0);
    }
  });

  it("marks the matched substring case-insensitively once the query is 3+ chars", () => {
    const c = mount("Fix the CRASH on launch", "crash");
    expect(c.textContent).toBe("Fix the CRASH on launch"); // original text preserved
    expect(marks(c)).toEqual(["CRASH"]); // matched slice keeps original casing
  });

  it("marks every occurrence", () => {
    const c = mount("feature/feature-flag", "feature");
    expect(marks(c)).toEqual(["feature", "feature"]);
    expect(c.textContent).toBe("feature/feature-flag");
  });

  it("leaves text untouched when the (3+ char) query doesn't occur", () => {
    const c = mount("alpha beta", "zzz");
    expect(c.textContent).toBe("alpha beta");
    expect(marks(c)).toHaveLength(0);
  });
});
