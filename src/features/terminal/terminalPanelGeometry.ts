import { TERMINAL_EDGE_MARGIN, TERMINAL_MAX_HEIGHT, TERMINAL_MIN_HEIGHT } from "@/lib/ui";

// Re-exported so terminal-feature consumers keep one import site for geometry.
export { TERMINAL_EDGE_MARGIN };
export const MIN_TERMINAL_WIDTH = 520;

export type TerminalResizeSide = "left" | "right";

export interface TerminalVertical {
  /** Gap from the window's bottom edge to the popup's bottom, in px. */
  bottom: number;
  height: number;
}

/** Move the popup's BOTTOM edge while keeping its top edge fixed. The top's
 * position is `bottom + height`, so that sum is held constant: dragging the
 * bottom edge down (`deltaY > 0`) lowers the bottom gap and grows the height,
 * both clamped so the height stays within [min, max] and the bottom never dips
 * below the edge margin. */
export function resizeTerminalFromBottom({
  start,
  deltaY,
}: {
  start: TerminalVertical;
  deltaY: number;
}): TerminalVertical {
  const topAnchor = start.bottom + start.height;
  // bottom range that keeps height in [min, max] AND bottom >= margin.
  const minBottom = Math.max(TERMINAL_EDGE_MARGIN, topAnchor - TERMINAL_MAX_HEIGHT);
  const maxBottom = topAnchor - TERMINAL_MIN_HEIGHT;
  const bottom = clamp(start.bottom - deltaY, minBottom, Math.max(minBottom, maxBottom));
  return { bottom, height: topAnchor - bottom };
}

export interface TerminalHorizontalInsets {
  left: number;
  right: number;
}

/** Move one terminal edge while keeping the opposite edge fixed. */
export function resizeTerminalInsets({
  side,
  start,
  deltaX,
  containerWidth,
}: {
  side: TerminalResizeSide;
  start: TerminalHorizontalInsets;
  deltaX: number;
  containerWidth: number;
}): TerminalHorizontalInsets {
  if (side === "left") {
    const maxLeft = Math.max(
      TERMINAL_EDGE_MARGIN,
      containerWidth - start.right - MIN_TERMINAL_WIDTH,
    );
    return {
      left: clamp(start.left + deltaX, TERMINAL_EDGE_MARGIN, maxLeft),
      right: start.right,
    };
  }

  const maxRight = Math.max(
    TERMINAL_EDGE_MARGIN,
    containerWidth - start.left - MIN_TERMINAL_WIDTH,
  );
  return {
    left: start.left,
    right: clamp(start.right - deltaX, TERMINAL_EDGE_MARGIN, maxRight),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
