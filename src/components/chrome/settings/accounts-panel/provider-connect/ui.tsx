// Presentational primitives shared by the provider-connect pieces: the section
// title/body block, the collapsible "Other ways to connect" disclosure, the
// external-link glyph, and the class strings that keep inputs/links/buttons
// consistent across the OAuth, CLI, and credential-helper paths.

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

export function StateBlock({
  title,
  body,
  children,
}: {
  title: string;
  body: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">{body}</p>
      {children && <div className="mt-3 flex flex-col gap-2.5">{children}</div>}
    </div>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

const iconCls = "h-4 w-4 shrink-0";
const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: iconCls,
};

/** A personal-access-token / credential method. */
export function KeyIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m10 13 8-8" />
      <path d="m15 8 2 2" />
      <path d="m18 5 2 2" />
    </svg>
  );
}

/** A CLI / terminal method. */
export function TerminalIcon() {
  return (
    <svg {...iconProps}>
      <path d="m7 10 3 3-3 3" />
      <path d="M13 16h4" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
    </svg>
  );
}

/** A native-OAuth method. */
export function ShieldIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3 5 6v5c0 4.2 2.9 7.5 7 9 4.1-1.5 7-4.8 7-9V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

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
