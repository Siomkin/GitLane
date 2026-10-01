// Presentational primitives shared by the provider-connect pieces: the
// method glyphs the shared icon set lacks, and the class strings that keep
// inputs/links/buttons consistent across the CLI, token, and credential-helper paths.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";

export const linkCls =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] hover:underline";

export const refreshBtnCls =
  "inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]";

export const inputCls = cn(
  "h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
  focusRing,
);

export const iconCls = "h-4 w-4 shrink-0";
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: iconCls,
};

/** Install-a-tool step. */
export function DownloadIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

/** SSH key auth — a padlock, distinct from the token's key glyph. */
export function LockIcon() {
  return (
    <svg {...iconProps}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
