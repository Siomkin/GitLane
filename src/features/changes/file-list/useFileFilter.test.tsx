import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, renderHook } from "@testing-library/react";
import { useUi } from "@/store/ui";
import { useFileFilter } from "./useFileFilter";

afterEach(() => useUi.setState({ menu: null }));

const typed = () => {
  const hook = renderHook(() => useFileFilter([]));
  act(() => hook.result.current.openFilter());
  act(() => hook.result.current.setQuery("app"));
  return hook;
};

describe("useFileFilter Escape", () => {
  it("closes and clears the filter when nothing else owns the key", () => {
    const { result } = typed();
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(result.current.open).toBe(false);
    expect(result.current.query).toBe("");
  });

  it("stands down while an overlay is open — that Esc belongs to the menu", () => {
    const { result } = typed();
    useUi.setState({ menu: { kind: "file" } as never });
    act(() => void fireEvent.keyDown(document, { key: "Escape" }));
    expect(result.current.open).toBe(true);
    expect(result.current.query).toBe("app");
  });
});
