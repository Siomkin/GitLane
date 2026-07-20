import { describe, it, expect } from "vitest";
import { orderWithPins } from "./pinning";

const row = (name: string, pinned = false, current = false) => ({ name, pinned, current });
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

describe("orderWithPins", () => {
  it("keeps the incoming order when nothing is pinned", () => {
    const { rows, separatorAt } = orderWithPins([row("a"), row("b"), row("c")]);
    expect(names(rows)).toEqual(["a", "b", "c"]);
    expect(separatorAt).toBeNull();
  });

  it("lifts pinned rows above unpinned, current above pinned, keeping in-rank order", () => {
    const { rows, separatorAt } = orderWithPins([
      row("a"),
      row("b", true),
      row("c", false, true),
      row("d", true),
      row("e"),
    ]);
    expect(names(rows)).toEqual(["c", "b", "d", "a", "e"]);
    expect(separatorAt).toBe(3);
  });

  it("reports no separator when every row is pinned or current", () => {
    const { rows, separatorAt } = orderWithPins([row("a", true), row("b", false, true)]);
    expect(names(rows)).toEqual(["b", "a"]);
    expect(separatorAt).toBeNull();
  });

  it("reports no separator when only the current row leads (nothing pinned)", () => {
    const { rows, separatorAt } = orderWithPins([row("a"), row("b", false, true)]);
    expect(names(rows)).toEqual(["b", "a"]);
    expect(separatorAt).toBeNull();
  });

  it("handles an empty list", () => {
    expect(orderWithPins([])).toEqual({ rows: [], separatorAt: null });
  });
});
