import { closestCenter, type CollisionDetector } from "@dnd-kit/collision";

/** A sortable's live place in its list. Read structurally: the collision
 * input is typed against @dnd-kit/abstract, which `isSortable`'s @dnd-kit/dom
 * overloads don't accept. */
interface Slot {
  index: number;
  group?: string | number;
}
const slotOf = (item: object | null): Slot | null =>
  item && typeof (item as Partial<Slot>).index === "number" ? (item as Slot) : null;

/**
 * Collision for the tab strip's sortables: an item is a target only if it is
 * ahead of the dragged one in the current order, in the direction the pointer
 * is moving, and the dragged item's centre has passed its centre.
 *
 * dnd-kit's stock rules pick by geometry alone. Right after a swap the passed
 * item is still animating to its new place, so its box sits where the dragged
 * one is heading, it gets picked again, and the pair swaps back — every few
 * pixels for a narrow tab crossing a group's well. Here an item already passed
 * is behind the dragged one in the order, so it can't be picked again until the
 * pointer turns round, and turning round must carry the dragged centre back
 * over the item's centre before it swaps.
 */
export const stripCollision: CollisionDetector = (input) => {
  const { dragOperation, droppable } = input;
  const { source, shape, position } = dragOperation;
  const base = closestCenter(input);
  const from = slotOf(source);
  const to = slotOf(droppable);
  if (!base || !droppable.shape || !from || !to) return null;
  // The dragged item's own slot stays a target, so standing still means "here".
  if (droppable.id === source?.id) return base;
  if (to.group !== from.group) return null;

  const dragged = shape?.current.center.x ?? position.current.x;
  const centre = droppable.shape.center.x;
  const ahead =
    position.direction === "left"
      ? to.index < from.index && dragged < centre
      : position.direction === "right"
        ? to.index > from.index && dragged > centre
        : false;
  if (!ahead) return null;
  // dnd-kit ranks by priority before value, and `base` keeps closestCenter's —
  // high when the pointer is inside the item. So an item under the pointer
  // wins; between equals, the nearest passed centre does, and any passed item
  // outscores the dragged item's own slot (whose 1/distance value only reaches
  // 1 within a pixel of its centre).
  return { ...base, value: 1 + 1 / (1 + Math.abs(dragged - centre)) };
};
