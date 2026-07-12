import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DragEvent } from "react";
import { renderHook } from "@testing-library/react";
import { useUi } from "@/store/ui";
import type { BranchDragRef } from "@/lib/graphActions";
import { useBranchRefDrag } from "./useBranchRefDrag";

const startDrag = vi.fn();
const clearDrag = vi.fn();
const openActionMenu = vi.fn();

// Snapshot the real store actions up front: seed() replaces them on the singleton
// store, so restore them after each test to keep the slice clean for later tests.
const realUiSlice = {
  draggingFrom: useUi.getState().draggingFrom,
  startDrag: useUi.getState().startDrag,
  clearDrag: useUi.getState().clearDrag,
  openActionMenu: useUi.getState().openActionMenu,
};

/** Seed the ui store with mocked drag actions + a current drag source. */
function seed(draggingFrom: BranchDragRef | null) {
  useUi.setState({ draggingFrom, startDrag, clearDrag, openActionMenu });
}

/** Minimal stand-in for a React drag event. */
function dragEvent() {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clientX: 11,
    clientY: 22,
    dataTransfer: { effectAllowed: "" as string, setData: vi.fn() },
  };
}

/** Render the hook and return its drag props, asserting it's the draggable shape. */
function draggableProps(
  refName: string,
  opts?: { kind?: "local" | "remote"; droppable?: boolean; stopPropagation?: boolean },
) {
  const { result } = renderHook(() =>
    useBranchRefDrag(refName, {
      draggable: true,
      kind: opts?.kind ?? "local",
      droppable: opts?.droppable ?? true,
      stopPropagation: opts?.stopPropagation,
    }),
  );
  const { dndProps, isDropTarget } = result.current;
  if (dndProps.draggable !== true) throw new Error("expected draggable dndProps");
  return { dndProps, isDropTarget };
}

afterEach(() => {
  useUi.setState(realUiSlice);
});

beforeEach(() => {
  startDrag.mockReset();
  clearDrag.mockReset();
  openActionMenu.mockReset();
});

describe("useBranchRefDrag", () => {
  it("is inert when not draggable (no handlers, never a drop target)", () => {
    seed({ name: "feature", kind: "local" });
    const { result } = renderHook(() => useBranchRefDrag("main", { draggable: false }));
    expect(result.current.dndProps).toEqual({ draggable: false });
    expect(result.current.isDropTarget).toBe(false);
  });

  it("marks a drop target only for a different in-flight ref", () => {
    seed({ name: "feature", kind: "local" });
    expect(draggableProps("main").isDropTarget).toBe(true);

    seed({ name: "main", kind: "local" }); // dragging onto itself
    expect(draggableProps("main").isDropTarget).toBe(false);

    seed(null); // nothing in flight
    expect(draggableProps("main").isDropTarget).toBe(false);
  });

  it("onDragStart begins the drag and seeds the dataTransfer", () => {
    seed(null);
    const { dndProps } = draggableProps("main");
    const e = dragEvent();
    dndProps.onDragStart(e as unknown as DragEvent<HTMLElement>);
    expect(e.dataTransfer.effectAllowed).toBe("move");
    expect(e.dataTransfer.setData).toHaveBeenCalledWith("text/plain", "main");
    expect(startDrag).toHaveBeenCalledWith({ name: "main", kind: "local" });
  });

  it("onDrop opens the action menu {from, to} for a valid drop", () => {
    seed({ name: "feature", kind: "local" });
    const { dndProps } = draggableProps("main");
    const e = dragEvent();
    dndProps.onDrop(e as unknown as DragEvent<HTMLElement>);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openActionMenu).toHaveBeenCalledWith({
      x: 11,
      y: 22,
      from: { name: "feature", kind: "local" },
      to: { kind: "local", name: "main" },
    });
    // openActionMenu clears the drag itself; no extra clearDrag in this path.
    expect(clearDrag).not.toHaveBeenCalled();
  });

  it("onDrop clears the drag when there is no distinct source", () => {
    seed({ name: "main", kind: "local" }); // dropping a ref on itself
    const { dndProps } = draggableProps("main");
    dndProps.onDrop(dragEvent() as unknown as DragEvent<HTMLElement>);
    expect(openActionMenu).not.toHaveBeenCalled();
    expect(clearDrag).toHaveBeenCalledTimes(1);
  });

  it("onDragEnd clears the drag", () => {
    seed({ name: "feature", kind: "local" });
    const { dndProps } = draggableProps("main");
    dndProps.onDragEnd();
    expect(clearDrag).toHaveBeenCalledTimes(1);
  });

  it("honors the stopPropagation option on dragStart + drop", () => {
    seed({ name: "feature", kind: "local" });
    const { dndProps } = draggableProps("main", { stopPropagation: true });
    const start = dragEvent();
    dndProps.onDragStart(start as unknown as DragEvent<HTMLElement>);
    expect(start.stopPropagation).toHaveBeenCalled();
    const drop = dragEvent();
    dndProps.onDrop(drop as unknown as DragEvent<HTMLElement>);
    expect(drop.stopPropagation).toHaveBeenCalled();
  });

  it("leaves propagation alone by default", () => {
    seed({ name: "feature", kind: "local" });
    const { dndProps } = draggableProps("main");
    const start = dragEvent();
    dndProps.onDragStart(start as unknown as DragEvent<HTMLElement>);
    expect(start.stopPropagation).not.toHaveBeenCalled();
    const drop = dragEvent();
    dndProps.onDrop(drop as unknown as DragEvent<HTMLElement>);
    expect(drop.stopPropagation).not.toHaveBeenCalled();
  });

  it("drops a local branch onto a remote ref as a remote target", () => {
    seed({ name: "develop", kind: "local" });
    const { dndProps } = draggableProps("origin/develop", { kind: "remote" });
    const drop = dragEvent();
    dndProps.onDrop(drop as unknown as DragEvent<HTMLElement>);
    expect(openActionMenu).toHaveBeenCalledWith({
      x: 11,
      y: 22,
      from: { name: "develop", kind: "local" },
      to: { kind: "remote", name: "origin/develop" },
    });
    expect(clearDrag).not.toHaveBeenCalled();
  });

  it("won't raise a menu when a remote ref is dropped onto a remote ref", () => {
    // A remote target can only receive a local branch; remote→remote is inert.
    seed({ name: "origin/feature", kind: "remote" });
    const { dndProps } = draggableProps("origin/develop", { kind: "remote" });
    const drop = dragEvent();
    dndProps.onDrop(drop as unknown as DragEvent<HTMLElement>);
    expect(openActionMenu).not.toHaveBeenCalled();
    expect(clearDrag).toHaveBeenCalledTimes(1);
  });
});
