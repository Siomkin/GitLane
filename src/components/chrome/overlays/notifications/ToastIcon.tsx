// Status glyph rendered inside the toast's tinted chip. Colour is inherited
// from the chip via `currentColor`. Paths are lifted verbatim from
// Notifications.dc.html so the icons match the mockup exactly.

import type { NotifyKind } from "@/store/notifications";

const BASE = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ToastIcon({ kind }: { kind: NotifyKind }) {
  switch (kind) {
    case "success":
      return (
        <svg {...BASE} strokeWidth={2.2} aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "warning":
      return (
        <svg {...BASE} strokeWidth={1.9} aria-hidden>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4M12 16.6v.4" />
        </svg>
      );
    case "error":
      return (
        <svg {...BASE} strokeWidth={1.9} aria-hidden>
          <circle cx={12} cy={12} r={9} />
          <path d="m15 9-6 6M9 9l6 6" />
        </svg>
      );
    case "progress":
      return (
        <svg {...BASE} strokeWidth={2} style={{ animation: "nf-spin 0.9s linear infinite" }} aria-hidden>
          <path d="M12 3a9 9 0 1 0 9 9" opacity={0.9} />
        </svg>
      );
    case "neutral":
      return (
        <svg {...BASE} strokeWidth={1.8} aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
      );
    case "info":
    default:
      return (
        <svg {...BASE} strokeWidth={1.9} aria-hidden>
          <circle cx={12} cy={12} r={9} />
          <path d="M12 11v5M12 7.6v.4" />
        </svg>
      );
  }
}
