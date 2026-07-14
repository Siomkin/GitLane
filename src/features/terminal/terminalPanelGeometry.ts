export const TERMINAL_EDGE_MARGIN = 8;
export const MIN_TERMINAL_WIDTH = 520;

export type TerminalResizeSide = "left" | "right";

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
