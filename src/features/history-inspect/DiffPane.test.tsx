import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { DiffLine, FileDiff } from "@/lib/api";
import { DiffPane } from "./DiffPane";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// happy-dom has no layout, so feed TanStack Virtual a viewport (the scroll
// element) and a measured height per row; otherwise the window degenerates to
// 0-height rows, nothing renders, and every assertion below passes vacuously.
beforeAll(() => {
  const isScroll = (el: HTMLElement) =>
    el.getAttribute("data-testid") === "inspect-diff-scroll";
  const rect = (height: number): DOMRect =>
    ({
      height,
      width: 600,
      top: 0,
      left: 0,
      right: 600,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return isScroll(this) ? 400 : 22;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.hasAttribute("data-index")) return rect(22);
      if (isScroll(this)) return rect(400);
      return rect(0);
    },
  });
});

const diffOf = (lines: number, truncated = false): FileDiff => ({
  path: "bun.lock",
  status: "M",
  add: lines,
  del: 0,
  binary: false,
  truncated,
  hunks: [
    {
      header: `@@ -1,${lines} +1,${lines} @@`,
      lines: Array.from(
        { length: lines },
        // Identifier-shaped, so the syntax highlighter emits it as ONE token
        // span; `line-0` would be split across `line` / `-` / `0` and no single
        // element would carry the text.
        (_, i): DiffLine => ({ kind: "add", content: `ln${i}`, oldNo: null, newNo: i + 1 }),
      ),
    },
  ],
});

describe("DiffPane", () => {
  it("windows a huge diff instead of mounting every line", () => {
    render(
      <DiffPane loading={false} diff={diffOf(5_000)} error={null} emptyLabel="Select a file." />,
    );

    // The first rows are present, so the pane really renders through the
    // virtualizer rather than silently painting nothing.
    expect(screen.getByText("ln0")).toBeInTheDocument();
    // ...but a line far past the viewport + overscan must not be in the DOM.
    // Before GL-234 this pane mounted all 5000 rows as raw DOM.
    expect(screen.queryByText("ln4999")).not.toBeInTheDocument();

    const scroller = screen.getByTestId("inspect-diff-scroll");
    const mounted = scroller.querySelectorAll("[data-index]").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);
  });

  it("keeps the truncated notice reachable outside the scrolled rows", () => {
    const onShowFull = vi.fn();
    render(
      <DiffPane
        loading={false}
        diff={diffOf(5_000, true)}
        error={null}
        emptyLabel="Select a file."
        onShowFull={onShowFull}
      />,
    );

    // The notice is a sibling of the scroll container, so it stays visible
    // without scrolling to the very end of a windowed list.
    const notice = screen.getByRole("button", { name: "Show full diff" });
    expect(notice).toBeInTheDocument();
    expect(screen.getByTestId("inspect-diff-scroll").contains(notice)).toBe(false);
  });
});
