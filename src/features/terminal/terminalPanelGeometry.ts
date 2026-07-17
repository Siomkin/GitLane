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

/** The tallest a panel may be without its top edge escaping the container: it
 * leaves the edge margin above the panel and below the current bottom gap.
 * Never below the min height, so a short window overflows rather than collapsing
 * the panel to nothing (the pre-existing tiny-window limitation). */
export function terminalMaxHeight(containerHeight: number, bottom: number): number {
  return Math.max(
    TERMINAL_MIN_HEIGHT,
    Math.min(TERMINAL_MAX_HEIGHT, containerHeight - TERMINAL_EDGE_MARGIN - bottom),
  );
}

/** Move the popup's BOTTOM edge while keeping its top edge fixed. The top's
 * position is `bottom + height`, so that sum ("topAnchor") is held constant:
 * dragging the bottom edge down (`deltaY > 0`) lowers the bottom gap and grows
 * the height, both clamped so the height stays within [min, max] and the bottom
 * never dips below the edge margin. `containerHeight` caps the topAnchor so a
 * panel whose stored geometry no longer fits (persisted from a taller window)
 * is pulled back into view on the next drag instead of preserving the overflow. */
export function resizeTerminalFromBottom({
  start,
  deltaY,
  containerHeight,
}: {
  start: TerminalVertical;
  deltaY: number;
  containerHeight: number;
}): TerminalVertical {
  const topAnchor = Math.min(
    start.bottom + start.height,
    containerHeight - TERMINAL_EDGE_MARGIN,
  );
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
