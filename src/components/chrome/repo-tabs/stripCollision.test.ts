import { Rectangle } from "@dnd-kit/geometry";
import { describe, expect, it } from "vitest";
import { stripCollision } from "./stripCollision";

type Input = Parameters<typeof stripCollision>[0];
type Direction = "left" | "right" | null;

/** A 30px-high strip: the dragged item is `drag` (its live index, the x of its
 * centre, and which way the pointer is going); `item` is the candidate. */
const collide = (
  drag: { index: number; centre: number; direction: Direction; group?: string },
  item: { id?: string; index: number; left: number; width: number; group?: string },
) =>
  stripCollision({
    dragOperation: {
      source: { id: "dragged", index: drag.index, group: drag.group },
      shape: { current: new Rectangle(drag.centre - 50, 0, 100, 30) },
      position: { current: { x: drag.centre, y: 15 }, direction: drag.direction },
    },
    droppable: {
      id: item.id ?? "item",
      index: item.index,
      group: item.group ?? drag.group,
      shape: new Rectangle(item.left, 0, item.width, 30),
    },
  } as unknown as Input);

// A wide item (a group's well) at index 0 spanning 0–300, centre 150, with the
// narrow dragged tab after it at index 1.
const well = { index: 0, left: 0, width: 300 };

describe("stripCollision", () => {
  it("targets an item ahead in the direction of travel once its centre is passed", () => {
    expect(collide({ index: 1, centre: 140, direction: "left" }, well)).not.toBeNull();
  });

  it("ignores an item ahead whose centre has not been passed yet", () => {
    expect(collide({ index: 1, centre: 160, direction: "left" }, well)).toBeNull();
  });

  it("ignores an item already passed, even while it is still animating under the pointer", () => {
    // After the swap the dragged tab is index 0 and the well index 1; mid-animation
    // the well's box still covers the dragged centre.
    expect(collide({ index: 0, centre: 100, direction: "left" }, { ...well, index: 1 })).toBeNull();
  });

  it("swaps back only once the pointer turns round and recrosses the centre", () => {
    const passed = { index: 1, left: 100, width: 300 }; // centre 250
    expect(collide({ index: 0, centre: 200, direction: "right" }, passed)).toBeNull();
    expect(collide({ index: 0, centre: 260, direction: "right" }, passed)).not.toBeNull();
  });

  it("never targets an item in another sortable group", () => {
    expect(
      collide({ index: 1, centre: 140, direction: "left", group: "g1" }, { ...well, group: "g2" }),
    ).toBeNull();
  });

  it("offers no new target while the pointer has no direction", () => {
    expect(collide({ index: 1, centre: 140, direction: null }, well)).toBeNull();
  });

  it("keeps the own slot as a target, outscored by a passed item under the same pointer", () => {
    // Both contain the pointer, so dnd-kit's priorities tie and the value decides.
    const own = collide(
      { index: 1, centre: 140, direction: "left" },
      { id: "dragged", index: 1, left: 100, width: 100 },
    );
    const passed = collide({ index: 1, centre: 140, direction: "left" }, well);
    expect(own).not.toBeNull();
    expect(passed!.value).toBeGreaterThan(own!.value);
  });
});
