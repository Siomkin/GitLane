import { useEffect, useRef } from "react";
import { useRepo } from "@/store/repo";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { GEOMETRY, graphLaneX, laneColor, rowY } from "./palette";
import { segmentIntersectsViewport } from "./graphViewport";
import type { StashConnector } from "./historyRows";

/** Opacity for de-emphasised graph elements (the lane skeleton + non-matching
 * nodes) while a search/kind filter is active — matches the dimmed commit rows. */
const DIM_ALPHA = 0.25;
const STASH_CONNECTOR = "#f59e0b";

interface GraphLayerProps {
  /** Absolute top of the bounded canvas inside the full history surface. */
  viewportTop: number;
  /** CSS-pixel height of the bounded canvas (including row overscan). */
  viewportHeight: number;
  /** Whether the WIP row is present (sits directly below the stash rows). */
  hasWip: boolean;
  rowHeight: number;
  graphWidth: number;
  branchOffset: number;
  /** Maps each graph row emitted by Rust to the virtual row currently shown. */
  visualRowByGraphRow: number[];
  /** Stash rows that should draw a side-lane connector to their base commit. */
  stashConnectors: StashConnector[];
  /** Ids matching the active search/kind filter, or null when nothing is
   * narrowing. When set, the lane skeleton and non-matching nodes are painted
   * dimmed so matched commits stand out on the DAG (mirrors the dimmed rows). */
  matchedIds?: Set<string> | null;
}

export function GraphLayer({
  viewportTop,
  viewportHeight,
  hasWip,
  rowHeight,
  graphWidth,
  branchOffset,
  visualRowByGraphRow,
  stashConnectors,
  matchedIds,
}: GraphLayerProps) {
  const graph = useRepo((state) => state.graph);
  const selectedCommits = useRepo((state) => state.selectedCommits);
  // Subscribe to the theme so a light/dark toggle re-runs the paint: the effect
  // samples theme-dependent colors (--nodeStroke, --headRing, and the section
  // background for merge-donut holes) that would otherwise stay stale until an
  // unrelated repaint.
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;

    const dpr = window.devicePixelRatio || 1;
    const width = graphWidth;
    const canvasHeight = Math.max(viewportHeight, 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${canvasHeight}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const root = canvas.closest(".gp-root") ?? document.documentElement;
    const styles = getComputedStyle(root);
    const nodeStroke = cssVar(styles, "--nodeStroke", "#ffffff");
    const headRing = cssVar(styles, "--headRing", "#0d1117");
    const selectedRing = "#2f9e7e";
    const head = graph.head;
    // The colour actually painted behind the canvas — the workspace surface, not
    // a token. Merge nodes punch a hole filled with this so the centre reads as a
    // clean cut-out (a donut) rather than a dot, regardless of theme.
    const surfaceEl = canvas.closest("section");
    const surface = surfaceEl
      ? getComputedStyle(surfaceEl).backgroundColor
      : cssVar(styles, "--bg", "#16181d");

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, canvasHeight);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // A search/kind filter dims everything that isn't a match — the lane
    // skeleton, the synthetic stash/WIP connectors, and non-matching nodes — so
    // the matches read as highlights (the canvas counterpart to the dimmed
    // rows). Set once here so the connectors below inherit it; the value carries
    // through `ctx.save()` to the edge pass and is reset before the node loop.
    const dimming = matchedIds != null;
    if (dimming) ctx.globalAlpha = DIM_ALPHA;

    const graphRowY = (graphRow: number) =>
      rowY(visualRowByGraphRow[graphRow] ?? graphRow + (hasWip ? 1 : 0), rowHeight);

    // Synthetic connectors. The WIP node hangs off HEAD; each stash row sits at
    // its own creation time in the date-ordered list, with a dashed connector
    // reaching down to its base commit wherever that lands — so the stash reads
    // as an annotation tied to its origin (GitKraken-style) rather than glued
    // beside it.
    if ((hasWip || stashConnectors.length > 0) && head) {
      const headCommit = graph.commits.find((commit) => commit.id === head);
      if (hasWip && headCommit) {
        const x = graphLaneX(headCommit.lane);
        const yHead = graphRowY(headCommit.row);
        const yWip = rowY(0, rowHeight);
        ctx.strokeStyle = laneColor(headCommit.color);
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 3]);
        if (segmentIntersectsViewport(yWip, yHead, viewportTop, canvasHeight, rowHeight)) {
          ctx.beginPath();
          ctx.moveTo(x, yWip + 7 - viewportTop);
          ctx.lineTo(x, yHead - viewportTop);
          ctx.stroke();
        }
        if (segmentIntersectsViewport(yWip, yWip, viewportTop, canvasHeight, rowHeight)) {
          ctx.beginPath();
          ctx.arc(x, yWip - viewportTop, 5.5, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    }

    const clampY = (value: number) =>
      Math.max(-rowHeight, Math.min(canvasHeight + rowHeight, value));
    for (const edge of graph.edges) {
      const x1 = graphLaneX(edge.fromLane);
      const y1 = graphRowY(edge.fromRow);
      const x2 = graphLaneX(edge.toLane);
      const y2 = graphRowY(edge.toRow);
      if (!segmentIntersectsViewport(y1, y2, viewportTop, canvasHeight, rowHeight)) {
        continue;
      }
      ctx.strokeStyle = laneColor(edge.color);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      const localY1 = clampY(y1 - viewportTop);
      const localY2 = clampY(y2 - viewportTop);
      ctx.moveTo(x1, localY1);
      if (x1 === x2) {
        ctx.lineTo(x2, localY2);
      } else {
        // Keep the elbow curvature stable while scrolling. The endpoints are
        // clamped to bound canvas coordinates, but the geometric radius should
        // still describe the full edge rather than the visible fragment.
        const radius = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1), 18);
        if (x1 < x2) {
          ctx.arcTo(x2, localY1, x2, localY2, radius);
        } else {
          ctx.arcTo(x1, localY2, x2, localY2, radius);
        }
        ctx.lineTo(x2, localY2);
      }
      ctx.stroke();
    }

    if (stashConnectors.length > 0) {
      ctx.lineWidth = 2.4;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = STASH_CONNECTOR;
      for (const connector of stashConnectors) {
        const x = graphLaneX(connector.anchorLane);
        const stashX = graphLaneX(connector.stashLane);
        const yAnchor = rowY(connector.anchorRow, rowHeight);
        const yStash = rowY(connector.stashRow, rowHeight);
        if (!segmentIntersectsViewport(yStash, yAnchor, viewportTop, canvasHeight, rowHeight)) {
          continue;
        }
        const towardAnchor = yAnchor > yStash ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(stashX, yStash + towardAnchor * 7 - viewportTop);
        ctx.lineTo(stashX, yAnchor - towardAnchor * 12 - viewportTop);
        ctx.quadraticCurveTo(
          stashX,
          yAnchor - viewportTop,
          x,
          yAnchor - viewportTop,
        );
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    // Build a membership set once per paint — `selectedCommits.includes()`
    // inside the per-commit loop would be O(n*m) for large graphs.
    const selectedSet = new Set(selectedCommits);

    for (const commit of graph.commits) {
      const x = graphLaneX(commit.lane);
      const globalY = graphRowY(commit.row);
      if (!segmentIntersectsViewport(globalY, globalY, viewportTop, canvasHeight, rowHeight)) {
        continue;
      }
      const y = globalY - viewportTop;
      const isSelected = selectedSet.has(commit.id);
      const isMerge = commit.parents.length > 1;
      const baseR = isSelected ? GEOMETRY.nodeRadius + 1.5 : GEOMETRY.nodeRadius;
      // Merge commits render as a noticeably larger hollow donut so they read
      // clearly as merges, distinct from the smaller filled commit dots.
      const outerR = isMerge ? baseR + 2.5 : baseR;
      const color = laneColor(commit.color);

      // Non-matching commits fade to the skeleton's strength; matched, selected,
      // and unfiltered commits paint solid so they stand out — a selected commit
      // is kept at full strength even when it doesn't match, or its selection
      // ring would be nearly invisible. Everything this node draws is scaled by
      // `nodeAlpha`.
      const nodeAlpha =
        !matchedIds || matchedIds.has(commit.id) || isSelected ? 1 : DIM_ALPHA;
      ctx.globalAlpha = nodeAlpha;

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(x, y, outerR + 4, 0, Math.PI * 2);
        ctx.strokeStyle = selectedRing;
        ctx.globalAlpha = nodeAlpha * 0.4;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = nodeAlpha;
      }

      if (isMerge) {
        // Lane-coloured ring with the workspace surface showing through, so the
        // centre is a clean cut-out (a donut), not a dot — the main-line merge
        // treatment, scaled up so the hole is unmistakable.
        ctx.beginPath();
        ctx.arc(x, y, outerR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, outerR - 2.8, 0, Math.PI * 2);
        ctx.fillStyle = surface;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, outerR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = nodeStroke;
        ctx.stroke();
      }

      if (commit.id === head) {
        ctx.beginPath();
        ctx.arc(x, y, outerR + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = headRing;
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
    }
  }, [
    graph,
    viewportTop,
    viewportHeight,
    selectedCommits,
    hasWip,
    rowHeight,
    graphWidth,
    visualRowByGraphRow,
    stashConnectors,
    theme,
    matchedIds,
  ]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute z-0 block"
      style={{ left: branchOffset, top: viewportTop }}
      aria-hidden="true"
    />
  );
}

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}
