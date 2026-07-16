import type { CommitNodeIdentity } from "./commitAgents";

/** Neutral fill behind the "+N" overflow badge and agent badge icons —
 * legible on both themes (design's neutral-700). */
const BADGE_NEUTRAL = "#4b5563";
// Design proportions (30px avatar: 2px gap, 1px ring) scaled to node size.
const GAP_RATIO = 2 / 15;
const RING_RATIO = 3 / 15;

/** Companion badge for co-authored commits: one co-author shows their own
 * mini avatar (agent icon or initials on their identity colour); several
 * collapse into a neutral "+N". */
export interface CommitNodeBadge {
  count: number;
  initials: string;
  color: string;
  image: HTMLImageElement | null;
}

interface DrawCommitNodeOptions {
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  outerRadius: number;
  /** Radius of the avatar disc when the node renders as an author avatar —
   * density-dependent (the row height bounds it), chosen by GraphLayer. */
  avatarRadius: number;
  color: string;
  surface: string;
  nodeStroke: string;
  headRing: string;
  selectedRing: string;
  nodeAlpha: number;
  selected: boolean;
  merge: boolean;
  head: boolean;
  identity: CommitNodeIdentity | null;
  agentImage: HTMLImageElement | null;
  badge: CommitNodeBadge | null;
}

/** Paint one commit node. A null identity is the preference-off fast path and
 * deliberately executes the classic dot/donut painter unchanged. Agent images
 * that are still decoding (or failed) use that same fallback. Avatar nodes
 * follow the "Author on the dot" design: the filled identity-coloured avatar
 * sits in a surface gap ringed by the lane colour (the accent ring when
 * selected), with the co-author badge tucked on the bottom-right edge. */
export function drawCommitNode({
  ctx,
  x,
  y,
  outerRadius,
  avatarRadius,
  color,
  surface,
  nodeStroke,
  headRing,
  selectedRing,
  nodeAlpha,
  selected,
  merge,
  head,
  identity,
  agentImage,
  badge,
}: DrawCommitNodeOptions) {
  const iconIdentity =
    identity?.kind === "human" || (identity?.kind === "agent" && agentImage)
      ? identity
      : null;
  const paintedRadius = iconIdentity
    ? Math.max(outerRadius, avatarRadius + (merge ? 1 : 0))
    : outerRadius;
  const gap = iconIdentity ? Math.max(1.2, paintedRadius * GAP_RATIO) : 0;
  const ringRadius = paintedRadius + gap + Math.max(1, paintedRadius * (RING_RATIO - GAP_RATIO));
  const selectedOffset = iconIdentity ? ringRadius - paintedRadius + 2 : 4;

  ctx.globalAlpha = nodeAlpha;
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, paintedRadius + selectedOffset, 0, Math.PI * 2);
    ctx.strokeStyle = selectedRing;
    ctx.globalAlpha = nodeAlpha * 0.4;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = nodeAlpha;
  }

  if (!iconIdentity) {
    drawClassicNode(ctx, x, y, outerRadius, color, surface, nodeStroke, merge);
    if (head) {
      ctx.beginPath();
      ctx.arc(x, y, outerRadius + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = headRing;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    return;
  }

  // Gap + hairline ring, the canvas equivalent of the design's stacked
  // box-shadow: lane colour normally, the accent (selection) colour when
  // selected. HEAD needs no extra ring — the avatar look marks it with the
  // "Checked out" pill and the dashed WIP connector, per the design.
  ctx.beginPath();
  ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
  ctx.fillStyle = selected ? selectedRing : color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, paintedRadius + gap, 0, Math.PI * 2);
  ctx.fillStyle = surface;
  ctx.fill();

  if (iconIdentity.kind === "human") {
    drawHumanAvatar(ctx, x, y, paintedRadius, iconIdentity.color, iconIdentity.initials);
  } else if (agentImage) {
    drawAgentIcon(ctx, x, y, paintedRadius, iconIdentity.agent.color, agentImage);
  }

  if (badge && badge.count > 0) {
    drawCoAuthorBadge(ctx, x, y, paintedRadius, surface, badge);
  }
}

function drawClassicNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  surface: string,
  nodeStroke: string,
  merge: boolean,
) {
  if (merge) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius - 2.8, 0, Math.PI * 2);
    ctx.fillStyle = surface;
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = nodeStroke;
  ctx.stroke();
}

function drawHumanAvatar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  initials: string,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.save();
  ctx.fillStyle = "#ffffff";
  const fontSize = initials.length === 1 ? radius * 0.95 : radius * 0.75;
  ctx.font = `700 ${fontSize.toFixed(1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, x, y + radius * 0.05);
  ctx.restore();
}

function drawAgentIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  image: HTMLImageElement,
) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  const iconRadius = radius - 1.4;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, iconRadius + 0.4, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    image,
    x - iconRadius,
    y - iconRadius,
    iconRadius * 2,
    iconRadius * 2,
  );
  ctx.restore();
}

function drawCoAuthorBadge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  avatarRadius: number,
  surface: string,
  badge: CommitNodeBadge,
) {
  // Design: 18px badge on a 30px node (0.6 radius ratio), sitting on the
  // bottom-right corner (`-bottom-1 -right-1`) so it overlaps the avatar rather
  // than floating past it, with a `ring-2` surface halo.
  const badgeRadius = Math.max(4, avatarRadius * 0.6);
  const bx = x + avatarRadius * 0.68;
  const by = y + avatarRadius * 0.68;
  const single = badge.count === 1;

  // Surface halo separates the badge from the avatar underneath (design's
  // `ring-2 ring-white`), then the badge disc itself.
  ctx.beginPath();
  ctx.arc(bx, by, badgeRadius + Math.max(1, badgeRadius * 0.22), 0, Math.PI * 2);
  ctx.fillStyle = surface;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(bx, by, badgeRadius, 0, Math.PI * 2);
  // A single co-author badges in its own colour (a human's identity colour or
  // an agent's brand colour behind the white glyph); an overflow "+N" is
  // neutral so it reads as a count, not a person.
  ctx.fillStyle = single ? badge.color : BADGE_NEUTRAL;
  ctx.fill();

  if (single && badge.image) {
    const iconRadius = badgeRadius * 0.8;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, iconRadius + 0.3, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(
      badge.image,
      bx - iconRadius,
      by - iconRadius,
      iconRadius * 2,
      iconRadius * 2,
    );
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.fillStyle = "#ffffff";
  const fontSize = single ? badgeRadius * 0.85 : badgeRadius * 0.95;
  ctx.font = `700 ${fontSize.toFixed(1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(single ? badge.initials : `+${badge.count}`, bx, by + badgeRadius * 0.05);
  ctx.restore();
}
