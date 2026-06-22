/** True when a vertical graph segment intersects the rendered canvas window. */
export function segmentIntersectsViewport(
  fromY: number,
  toY: number,
  viewportTop: number,
  viewportHeight: number,
  padding = 0,
): boolean {
  const minY = Math.min(fromY, toY);
  const maxY = Math.max(fromY, toY);
  const viewportBottom = viewportTop + viewportHeight;
  return maxY >= viewportTop - padding && minY <= viewportBottom + padding;
}
