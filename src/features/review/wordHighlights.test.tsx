import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { FileDiff } from "@/lib/api";
import { DIFF_ADD_WORD } from "@/lib/diffTones";
import { SplitDiff } from "./SplitDiff";
import { UnifiedDiff } from "./UnifiedDiff";

// No layout in the DOM test environment: give the virtual list a viewport and
// rows a height, as ReviewWorkspace.test.tsx does.
beforeAll(() => {
  const isScroll = (el: HTMLElement) => /review-(unified|split)-scroll/.test(el.getAttribute("data-testid") ?? "");
  const rect = (height: number) =>
    ({ height, width: 600, top: 0, left: 0, right: 600, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return isScroll(this) ? 400 : 19;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      if (this.hasAttribute("data-index")) return rect(19);
      return rect(isScroll(this) ? 400 : 0);
    },
  });
});

const file: FileDiff = {
  path: "notes.txt",
  status: "M",
  add: 1,
  del: 1,
  binary: false,
  truncated: false,
  hunks: [
    {
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { kind: "ctx", oldNo: 1, newNo: 1, content: "line 1" },
        { kind: "del", oldNo: 2, newNo: null, content: "line 2" },
        { kind: "add", oldNo: null, newNo: 2, content: "line 2 changed" },
      ],
    },
  ],
};

const markedWord = () => {
  const word = screen.getByText("changed");
  return word.style.background.replace(/\s/g, "");
};

describe("changed-word highlights", () => {
  it("tints the changed word in the unified view", () => {
    render(<UnifiedDiff file={file} hunkAction={null} surface="test" />);
    expect(markedWord()).toBe(DIFF_ADD_WORD);
  });

  it("tints the changed word in the split view", () => {
    render(<SplitDiff file={file} hunkAction={null} surface="test" />);
    expect(markedWord()).toBe(DIFF_ADD_WORD);
  });
});
