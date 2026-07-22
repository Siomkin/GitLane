import { useEffect, useMemo, useRef } from "react";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { GEOMETRY, graphLaneX, laneColor, rowY } from "./palette";
import { commitNodeIdentity } from "./commitAgents";
import { readyCommitAgentImage } from "./commitAgentImages";
import { drawCommitNode, type CommitNodeBadge } from "./commitNodePainter";
import { buildGraphPaintIndex, queryGraphPaintIndex } from "./graphPaintIndex";
import { useCommitAgentImages } from "./useCommitAgentImages";
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
  const showCommitNodeIcons = useUi((state) => state.showCommitNodeIcons);
  const identityColors = useUi((state) => state.identityColors);
  const commitAgentImageRevision = useCommitAgentImages(showCommitNodeIcons);
  // Subscribe to the theme so a light/dark toggle re-runs the paint: the effect
  // samples theme-dependent colors (--nodeStroke, --headRing, and the section
  // background for merge-donut holes) that would otherwise stay stale until an
  // unrelated repaint.
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paintIndex = useMemo(
    () =>
      graph
        ? buildGraphPaintIndex({ graph, visualRowByGraphRow, stashConnectors, hasWip })
        : null,
    [graph, visualRowByGraphRow, stashConnectors, hasWip],
  );
  const paintCandidates = useMemo(
    () =>
      paintIndex
        ? queryGraphPaintIndex(paintIndex, {
            viewportTop,
            viewportHeight: Math.max(viewportHeight, 1),
            rowHeight,
          })
        : null,
    [paintIndex, viewportTop, viewportHeight, rowHeight],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph || !paintCandidates) return;

    const dpr = window.devicePixelRatio || 1;
    const width = graphWidth;
    const canvasHeight = Math.max(viewportHeight, 1);
    const deviceWidth = Math.round(width * dpr);
    const deviceHeight = Math.round(canvasHeight * dpr);
    // Assigning `width`/`height` resets the bitmap — per spec even when the value
    // is unchanged — which reallocates the whole backing store. `viewportTop` is
    // one of this effect's deps, so an unconditional assignment burned a fresh
    // multi-MB surface on every scroll tick. Resize only when the pixel size
    // actually changed; `clearRect` below blanks the canvas either way. The state
    // the skeleton pass would otherwise inherit from the reset — transform, line
    // caps, dash, alpha — is re-established below; `strokeStyle` and `lineWidth`
    // are set per draw section, before each stroke.
    if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
      canvas.width = deviceWidth;
      canvas.height = deviceHeight;
    }
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

    // Clear the intrinsic bitmap under the identity transform, not the CSS box
    // under the dpr transform: the backing store is `Math.round(css * dpr)`, so a
    // fractional dpr can round *up* past the CSS extent (210px at dpr 1.25 gives a
    // 263px bitmap but only covers 262.5). The old code resized every paint, so the
    // spec's bitmap reset always blanked that fringe; now that resizes are guarded,
    // an under-reaching clear would leave a stale sliver at the edge.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // A search/kind filter dims everything that isn't a match — the lane
    // skeleton, the synthetic stash/WIP connectors, and non-matching nodes — so
    // the matches read as highlights (the canvas counterpart to the dimmed
    // rows). Set once here so the connectors below inherit it; the value persists
    // through the edge pass and is reset before the node loop.
    // Assigned on both branches, not just when dimming: the canvas is no longer
    // resized on every paint, so nothing implicitly restores alpha to 1 and the
    // previous paint's dimmed value would otherwise bleed into this one.
    const dimming = matchedIds != null;
    ctx.globalAlpha = dimming ? DIM_ALPHA : 1;

    // Synthetic connectors. The WIP node hangs off HEAD; each stash row sits at
    // its own creation time in the date-ordered list, with a dashed connector
    // reaching down to its base commit wherever that lands — so the stash reads
    // as an annotation tied to its origin rather than glued
    // beside it.
    const indexedWip = paintCandidates.wipConnector ?? paintCandidates.wipNode;
    if (indexedWip) {
      const wipLane = indexedWip.lane;
      const x = graphLaneX(wipLane);
      const headX = graphLaneX(indexedWip.headCommit.lane);
      const yHead = rowY(indexedWip.headVisualRow, rowHeight);
      const yWip = rowY(0, rowHeight);
      ctx.strokeStyle = laneColor(indexedWip.color);
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 3]);
      if (paintCandidates.wipConnector) {
        ctx.beginPath();
        ctx.moveTo(x, yWip + 7 - viewportTop);
        if (x === headX) {
          ctx.lineTo(x, yHead - viewportTop);
        } else {
          ctx.lineTo(x, yHead - 12 - viewportTop);
          ctx.quadraticCurveTo(x, yHead - viewportTop, headX, yHead - viewportTop);
        }
        ctx.stroke();
      }
      if (paintCandidates.wipNode) {
        ctx.beginPath();
        ctx.arc(x, yWip - viewportTop, 5.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    const clampY = (value: number) =>
      Math.max(-rowHeight, Math.min(canvasHeight + rowHeight, value));
    for (const indexedEdge of paintCandidates.edges) {
      const edge = indexedEdge.edge;
      const x1 = graphLaneX(edge.fromLane);
      const y1 = rowY(indexedEdge.fromVisualRow, rowHeight);
      const x2 = graphLaneX(edge.toLane);
      const y2 = rowY(indexedEdge.toVisualRow, rowHeight);
      const isStashEdge = indexedEdge.stash;
      ctx.strokeStyle = isStashEdge ? STASH_CONNECTOR : laneColor(edge.color);
      ctx.lineWidth = 2.4;
      ctx.setLineDash(isStashEdge ? [3, 4] : []);
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
        if ((edge.parentIndex ?? 0) > 0) {
          ctx.arcTo(x2, localY1, x2, localY2, radius);
        } else {
          ctx.arcTo(x1, localY2, x2, localY2, radius);
        }
        ctx.lineTo(x2, localY2);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (paintCandidates.stashConnectors.length > 0) {
      ctx.lineWidth = 2.4;
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = STASH_CONNECTOR;
      for (const indexedConnector of paintCandidates.stashConnectors) {
        const connector = indexedConnector.connector;
        const x = graphLaneX(connector.anchorLane);
        const stashX = graphLaneX(connector.stashLane);
        const yAnchor = rowY(connector.anchorRow, rowHeight);
        const yStash = rowY(connector.stashRow, rowHeight);
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

    // The avatar is the node, so let it dominate the row. We deliberately fill
    // more of the compact row than the (taller, airier) design mock does, since
    // the app keeps rows dense — bounded so the avatar + ring never touches the
    // row edge.
    const avatarRadius = rowHeight >= 40 ? 13 : 10;

    for (const indexedCommit of paintCandidates.commits) {
      const commit = indexedCommit.commit;
      const x = graphLaneX(commit.lane);
      const globalY = rowY(indexedCommit.visualRow, rowHeight);
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

      // Resolve metadata only after the viewport gate, and bypass it entirely
      // for the classic-dots preference. The icon cache contains only the tiny
      // fixed registry; a loading icon falls back to this exact classic painter,
      // and a failed icon safely stays there.
      const identity = showCommitNodeIcons ? commitNodeIdentity(commit, identityColors) : null;
      const agentImage =
        identity?.kind === "agent" ? readyCommitAgentImage(identity.agent) : null;
      const coAuthors = identity && identity.kind !== "fallback" ? identity.coAuthors : [];
      const badge: CommitNodeBadge | null =
        coAuthors.length === 0
          ? null
          : {
              count: coAuthors.length,
              initials: coAuthors[0].initials,
              color: coAuthors[0].color,
              image: coAuthors[0].agent ? readyCommitAgentImage(coAuthors[0].agent) : null,
            };
      drawCommitNode({
        ctx,
        x,
        y,
        outerRadius: outerR,
        avatarRadius,
        color,
        surface,
        nodeStroke,
        headRing,
        selectedRing,
        nodeAlpha,
        selected: isSelected,
        merge: isMerge,
        head: commit.id === head,
        identity,
        agentImage,
        badge,
      });
    }
  }, [
    graph,
    paintCandidates,
    viewportTop,
    viewportHeight,
    selectedCommits,
    rowHeight,
    graphWidth,
    theme,
    matchedIds,
    showCommitNodeIcons,
    identityColors,
    commitAgentImageRevision,
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
