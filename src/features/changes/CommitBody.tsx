import { useId, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

const COLLAPSED_MAX = 78; // px — ~3 lines of body text left peeking under the fade
const FADE_MASK = "linear-gradient(to bottom,#000 50%,transparent)";

/** A commit message body that collapses behind a "Show full message" /
 * "Collapse" toggle when it is long. Collapsed text is clipped to a few lines
 * and faded out under a gradient mask; toggling animates the height open/closed. */
export function CommitBody({ body }: { body: string }) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const prevCollapsed = useRef<boolean | null>(null);
  const bodyId = useId();
  const long = body.length > 220 || body.split("\n").length > 3;
  const collapsed = long && !expanded;

  // Drive `max-height` imperatively so the open/close actually animates: CSS
  // can't interpolate to/from `none`, so we always transition between two pixel
  // values. The measured scrollHeight is the expanded target; once the open
  // transition settles we release to `none` so a later reflow (panel resize)
  // isn't clipped. We only animate on a real toggle (prev !== current), never on
  // mount. `max-height` is never set via the style prop, so React's style
  // reconciliation leaves these imperative writes alone.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !long) {
      if (el) el.style.maxHeight = ""; // a no-longer-long body must not stay clipped
      prevCollapsed.current = collapsed;
      return;
    }
    const animate = prevCollapsed.current !== null && prevCollapsed.current !== collapsed;
    prevCollapsed.current = collapsed;

    if (collapsed) {
      if (animate) {
        // Pin the CURRENT rendered height (not full scrollHeight) so collapsing
        // mid-expand shrinks smoothly instead of snapping to full height first.
        el.style.maxHeight = `${el.getBoundingClientRect().height}px`;
        void el.offsetHeight; // force reflow so the shrink interpolates
      }
      el.style.maxHeight = `${COLLAPSED_MAX}px`;
      return;
    }

    if (!animate) {
      el.style.maxHeight = "none";
      return;
    }
    el.style.maxHeight = `${el.scrollHeight}px`;
    const release = (e: TransitionEvent) => {
      if (e.propertyName === "max-height") el.style.maxHeight = "none";
    };
    el.addEventListener("transitionend", release);
    return () => el.removeEventListener("transitionend", release);
  }, [collapsed, long]);

  if (!body.trim()) return null;

  return (
    <div>
      <p
        ref={ref}
        id={bodyId}
        className="overflow-hidden whitespace-pre-wrap text-[13.5px] leading-relaxed text-neutral-500 transition-[max-height] duration-300 ease-out motion-reduce:transition-none dark:text-neutral-400 text-pretty"
        style={collapsed ? { WebkitMaskImage: FADE_MASK, maskImage: FADE_MASK } : undefined}
      >
        {body}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className={cn(
            "mt-1.5 ml-auto flex items-center gap-1 rounded text-[12px] font-medium text-[color:var(--accent)] hover:underline",
            focusRing,
          )}
        >
          {expanded ? "Collapse" : "Show full message"}
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 transition-transform duration-200 motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
    </div>
  );
}
