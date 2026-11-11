import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTabStripScroll } from "./useTabStripScroll";

const Strip = ({ active }: { active: string | null }) => {
  const strip = useTabStripScroll(active);
  return (
    <div data-testid="scroller" ref={strip.scrollerRef} style={strip.style}>
      <div ref={strip.contentRef} />
    </div>
  );
};

// happy-dom has no layout, so the scroller's geometry is stubbed.
const size = (el: HTMLElement, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
};

describe("useTabStripScroll", () => {
  it("fades only the edges that hide tabs", () => {
    const { getByTestId } = render(<Strip active={null} />);
    const el = getByTestId("scroller");
    expect(el.style.maskImage).toBe("");

    size(el, 1000, 400);
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toMatch(/^linear-gradient\(to right, #000 0px, .*transparent calc/);

    el.scrollLeft = 600;
    act(() => el.dispatchEvent(new Event("scroll")));
    expect(el.style.maskImage).toMatch(/^linear-gradient\(to right, transparent 24px, .*#000 100%\)$/);
  });

  it("turns a vertical wheel into sideways scroll", () => {
    const { getByTestId } = render(<Strip active={null} />);
    const el = getByTestId("scroller");
    size(el, 1000, 400);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }));
    expect(el.scrollLeft).toBe(120);
  });
});
