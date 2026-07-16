import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommitNode } from "@/lib/api";
import { commitNodeIdentity, type CommitCoAuthor } from "@/features/graph/commitAgents";
import { graphLaneX } from "@/features/graph/palette";
import { useUi } from "@/store/ui";

/** Hover target sitting on the painted commit node; the author card drops in
 * beside it. The node is the author, the card is the "rest" (name, full email,
 * co-authors) so the row itself stays message + sha only. The card is portaled
 * into `.gp-root` as a `position: fixed` layer (the same escape hatch the
 * change surfaces use) so it clears the history surface's scroll clipping — a
 * plain absolute card would be cut off on the first/last visible rows — and is
 * clamped into the viewport. It is purely informational; identity colours are
 * customised in Settings → Identities. */
export function NodeHoverCard({ commit, graphColW }: { commit: CommitNode; graphColW: number }) {
  const identityColors = useUi((state) => state.identityColors);
  const identity = commitNodeIdentity(commit, identityColors);
  const targetRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  // The node is painted (and clipped) inside the graph column; if its lane sits
  // beyond a narrowed column the canvas doesn't draw it, so the hover target
  // must not linger over the message column either.
  if (identity.kind === "fallback" || graphLaneX(commit.lane) > graphColW) return null;

  const name = identity.kind === "agent" ? identity.agent.label : commit.authorName;

  const show = () => {
    const rect = targetRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.right, y: rect.top + rect.height / 2 });
  };

  return (
    <div
      ref={targetRef}
      className="absolute top-1/2 z-20 h-[30px] w-[30px] -translate-x-1/2 -translate-y-1/2"
      style={{ left: graphLaneX(commit.lane) }}
      onMouseEnter={show}
      onMouseLeave={() => setAnchor(null)}
      data-testid="node-hover-target"
    >
      {anchor && (
        <HoverCard
          anchor={anchor}
          name={name}
          email={commit.authorEmail}
          initials={identity.kind === "human" ? identity.initials : name.slice(0, 1).toUpperCase()}
          color={identity.kind === "human" ? identity.color : identity.agent.color}
          iconUrl={identity.kind === "agent" ? identity.agent.iconUrl : null}
          coAuthors={identity.coAuthors}
        />
      )}
    </div>
  );
}

function HoverCard({
  anchor,
  name,
  email,
  initials,
  color,
  iconUrl,
  coAuthors,
}: {
  anchor: { x: number; y: number };
  name: string;
  email: string;
  initials: string;
  color: string;
  iconUrl: string | null;
  coAuthors: CommitCoAuthor[];
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Start beside/centred on the node; a layout pass (before paint, so no flash)
  // clamps the card into the viewport on both axes once its real size is known.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x + 10, top: anchor.y });

  useLayoutEffect(() => {
    const el = cardRef.current;
    const height = el?.offsetHeight ?? 0;
    const width = el?.offsetWidth ?? 280;
    const maxTop = window.innerWidth ? window.innerHeight - height - 8 : 0;
    const maxLeft = window.innerWidth - width - 8;
    setPos({
      left: Math.min(Math.max(8, anchor.x + 10), Math.max(8, maxLeft)),
      top: Math.min(Math.max(8, anchor.y - height / 2), Math.max(8, maxTop)),
    });
  }, [anchor, coAuthors.length]);

  const host = document.querySelector<HTMLElement>(".gp-root") ?? document.body;

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-[280px] rounded-xl border border-black/10 bg-white p-3 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.28)] dark:border-white/10 dark:bg-neutral-900"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="flex items-center gap-2.5">
        <PersonBadge initials={initials} color={color} iconUrl={iconUrl} size="lg" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
            {name}
          </div>
          <div className="break-all font-mono text-[11px] text-neutral-400">{email}</div>
        </div>
      </div>

      {coAuthors.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5 border-t border-black/[0.06] pt-2.5 dark:border-white/[0.08]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">
            Co-authored · {coAuthors.length}
          </div>
          {coAuthors.map((coAuthor) => (
            <div key={coAuthor.email} className="flex items-center gap-2">
              <PersonBadge
                initials={coAuthor.initials}
                color={coAuthor.color}
                iconUrl={coAuthor.agent?.iconUrl ?? null}
                size="sm"
              />
              <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">
                {coAuthor.agent?.label ?? coAuthor.name}
              </span>
              <span className="truncate font-mono text-[11px] text-neutral-400">{coAuthor.email}</span>
            </div>
          ))}
        </div>
      )}
    </div>,
    host,
  );
}

function PersonBadge({
  initials,
  color,
  iconUrl,
  size,
}: {
  initials: string;
  color: string;
  iconUrl: string | null;
  size: "sm" | "lg";
}) {
  const box = size === "lg" ? "h-9 w-9 text-[12px]" : "h-6 w-6 text-[9px]";
  return (
    <div
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold text-white ${box}`}
      style={{ background: color }}
    >
      {iconUrl ? (
        <img src={iconUrl} alt="" className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
      ) : (
        initials
      )}
    </div>
  );
}
