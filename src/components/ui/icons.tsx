import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconBase>
  );
}

export function FilterIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </IconBase>
  );
}

// Windows/Linux caption controls. Drawn on a 10×10 grid with a thin even stroke
// to match the OS-native min/restore/close glyphs (which our frameless window
// replaces). `fill="none"` keeps them outline-only.
function CaptionIcon({ children, ...props }: IconProps) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function WindowMinimizeIcon(props: IconProps) {
  return (
    <CaptionIcon {...props}>
      <line x1="1" y1="5" x2="9" y2="5" />
    </CaptionIcon>
  );
}

export function WindowMaximizeIcon(props: IconProps) {
  return (
    <CaptionIcon {...props}>
      <rect x="1" y="1" width="8" height="8" />
    </CaptionIcon>
  );
}

export function WindowRestoreIcon(props: IconProps) {
  return (
    <CaptionIcon {...props}>
      <rect x="1" y="3" width="6" height="6" />
      <path d="M3 3V1h6v6H7" />
    </CaptionIcon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.04a1.7 1.7 0 0 0 1.56 1H21a2 2 0 0 1 0 4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </IconBase>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8Z" />
    </IconBase>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </IconBase>
  );
}

/** GitLane brand mark — the git-branch glyph (two hollow left nodes joined by a
 * trunk; a branch tees off and rounds up into the filled top-right node), the
 * same mark used on the app icon. Used on the About tile and settings footer. */
export function GitLaneMarkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 8.6V16.1" />
      <path d="M5.5 14.4C5.5 12.5 6.9 11.9 8.4 11.9H16.4C17.6 11.9 18.2 11.1 18.2 9.9V8.6" />
      <circle cx="5.5" cy="5.5" r="2.6" />
      <circle cx="5.5" cy="18.7" r="2.6" />
      <circle cx="18.2" cy="5.5" r="2.95" fill="currentColor" />
    </IconBase>
  );
}

/** Software-update glyph: an arrow dropping into a tray line. Shown in the
 * titlebar (accent-tinted) when an update is available — see UpdateIndicator. */
export function UpdateIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v11m0 0 4-4m-4 4-4-4" />
      <path d="M5 18.5h14" />
    </IconBase>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2.5h6.5A2.5 2.5 0 0 1 21 9v8.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" />
    </IconBase>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 4.5v8.9" />
      <path d="M7 18.6v1" />
      <path d="M9.6 16c4.7 0 7.4-3.3 7.4-7.5" />
      <circle cx="7" cy="16" r="2.6" fill="none" />
      <circle cx="17" cy="5.9" r="2.6" fill="none" />
    </IconBase>
  );
}

export function PullIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3v14" />
      <path d="m7 12 5 5 5-5" />
      <path d="M5 21h14" />
    </IconBase>
  );
}

export function PushIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 21V7" />
      <path d="m7 12 5-5 5 5" />
      <path d="M5 3h14" />
    </IconBase>
  );
}

export function FetchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 12a9 9 0 0 1 14.7-6.9L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-14.7 6.9L3 16" />
      <path d="M3 21v-5h5" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </IconBase>
  );
}

export function StashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      {/* changes dropping into the stash */}
      <path d="M12 3.5v5.5" />
      <path d="m9 6.5 3 3 3-3" />
      {/* the stash shelf / inbox tray */}
      <path d="M3 13h4.2l1.3 2.1a1 1 0 0 0 .85.47h5.3a1 1 0 0 0 .85-.47L16.8 13H21v4.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5V13Z" />
    </IconBase>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  );
}

export function LaptopIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M2 20h20" />
    </IconBase>
  );
}

export function CloudIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 18 18Z" />
    </IconBase>
  );
}

export function TreeIcon(props: IconProps) {
  // A git-fork glyph (one node splitting into two) — used for worktree
  // affordances: it reads as "this branch also lives in another checkout".
  return (
    <IconBase {...props}>
      <circle cx="12" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M12 8.5V13" />
      <path d="M6 15.5V14a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1.5" />
    </IconBase>
  );
}

export function CloudOffIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M7 18a4 4 0 0 1-.7-7.95" />
      <path d="M9.6 6.5A5 5 0 0 1 16.6 8.5 3.5 3.5 0 0 1 18.7 14.9" />
      <path d="M3 3l18 18" />
    </IconBase>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 18 6-6-6-6" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </IconBase>
  );
}

export function IssueIcon(props: IconProps) {
  // Open-issue glyph: ring with a filled centre dot (the dot opts out of the
  // base stroke/fill so it reads as solid).
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function PeopleIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </IconBase>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </IconBase>
  );
}

export function WebhookIcon(props: IconProps) {
  // Two interlocking arcs — the "link / hook" mark used for repo webhooks.
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </IconBase>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 8.2-8.2" />
      <path d="m15 6 3 3" />
      <path d="m18 3 3 3" />
    </IconBase>
  );
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
    </IconBase>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  // Inline "opens elsewhere" affordance. Always use this instead of the "↗"
  // text glyph — Windows font fallback renders U+2197 as a legacy color emoji.
  return (
    <IconBase strokeWidth="2" {...props}>
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </IconBase>
  );
}

export function RemotesIcon(props: IconProps) {
  // A cloud with a download arrow — "manage remotes" (pull a remote down).
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
      <path d="M12 12v6" />
      <path d="m9.5 15.5 2.5 2.5 2.5-2.5" />
    </IconBase>
  );
}

export function IdCardIcon(props: IconProps) {
  // An ID card — the repo "commit identity" section.
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M14 9h4M14 13h4M5 16h7" />
    </IconBase>
  );
}

export function RepoBookIcon(props: IconProps) {
  // A book spine — the Repository settings header mark.
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="2" {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
      <path d="M13.5 6.5l4 4" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="2.2" {...props}>
      <path d="m5 12 5 5L20 7" />
    </IconBase>
  );
}

/** Filled four-point sparkle marking agent/AI affordances. */
export function SparkleIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 3l1.6 4.9L18.5 9.5l-4.9 1.6L12 16l-1.6-4.9L5.5 9.5l4.9-1.6z" />
    </svg>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h5" />
    </IconBase>
  );
}

export function CompareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 7h10M7 7l3-3M7 7l3 3M17 17H7M17 17l-3-3M17 17l-3 3" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </IconBase>
  );
}

export function HashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
    </IconBase>
  );
}

export function MoreVerticalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14" />
    </IconBase>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <path d="M12 17v5M9 10.8V4h6v6.8l2 2.2H7z" />
    </IconBase>
  );
}

export function PinFilledIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1" {...props}>
      <path d="M12 17v5" strokeWidth="1.7" />
      <path d="M9 10.8V4h6v6.8l2 2.2H7z" fill="currentColor" />
    </IconBase>
  );
}

/** Three list lines with leading dots — the navigator's "All" category. */
export function ListIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="1.7" {...props}>
      <line x1="8" y1="6" x2="20" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function CommentIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 6.5A3.5 3.5 0 0 1 8.5 3h7A3.5 3.5 0 0 1 19 6.5v4A3.5 3.5 0 0 1 15.5 14H12l-5 4v-4.3A3.5 3.5 0 0 1 5 10.5z" />
      <path d="M9 8h6M9 11h4" />
    </IconBase>
  );
}

export function MessageSquareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </IconBase>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <IconBase strokeWidth="2" {...props}>
      <path d="M5 12h14" />
    </IconBase>
  );
}

/** Filled diamond — the "hand to agent" marker. */
export function DiamondIcon(props: IconProps) {
  return (
    <IconBase fill="currentColor" stroke="none" {...props}>
      <path d="M12 2 22 12 12 22 2 12z" />
    </IconBase>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.3.2 2.3.1 2.6a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.8v2.6c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

/** Bitbucket mark — the tapered "bucket" silhouette with the signature centre
 * notch (rendered as negative space so it inherits the surrounding tone). */
export function BitbucketIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.3 3.5a.7.7 0 0 0-.69.82l2.55 15.3c.07.41.42.71.84.71h11.9c.32 0 .59-.23.64-.54l2.55-15.48a.7.7 0 0 0-.69-.81L3.3 3.5Zm10.9 11.62H9.86L8.69 9.04h6.62l-1.11 6.08Z"
      />
    </svg>
  );
}

/** GitLab tanuki mark (official monochrome path). */
export function GitLabIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  );
}

/** Gitea tea-cup mark (official monochrome path). */
export function GiteaIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M4.209 4.603c-.247 0-.525.02-.84.088-.333.07-1.28.283-2.054 1.027C-.403 7.25.035 9.685.089 10.052c.065.446.263 1.687 1.21 2.768 1.749 2.141 5.513 2.092 5.513 2.092s.462 1.103 1.168 2.119c.955 1.263 1.936 2.248 2.89 2.367 2.406 0 7.212-.004 7.212-.004s.458.004 1.08-.394c.535-.324 1.013-.893 1.013-.893s.492-.527 1.18-1.73c.21-.37.385-.729.538-1.068 0 0 2.107-4.471 2.107-8.823-.042-1.318-.367-1.55-.443-1.627-.156-.156-.366-.153-.366-.153s-4.475.252-6.792.306c-.508.011-1.012.023-1.512.027v4.474l-.634-.301c0-1.39-.004-4.17-.004-4.17-1.107.016-3.405-.084-3.405-.084s-5.399-.27-5.987-.324c-.187-.011-.401-.032-.648-.032zm.354 1.832h.111s.271 2.269.6 3.597C5.549 11.147 6.22 13 6.22 13s-.996-.119-1.641-.348c-.99-.324-1.409-.714-1.409-.714s-.73-.511-1.096-1.52C1.444 8.73 2.021 7.7 2.021 7.7s.32-.859 1.47-1.145c.395-.106.863-.12 1.072-.12zm8.33 2.554c.26.003.509.127.509.127l.868.422-.529 1.075a.686.686 0 0 0-.614.359.685.685 0 0 0 .072.756l-.939 1.924a.69.69 0 0 0-.66.527.687.687 0 0 0 .347.763.686.686 0 0 0 .867-.206.688.688 0 0 0-.069-.882l.916-1.874a.667.667 0 0 0 .237-.02.657.657 0 0 0 .271-.137 8.826 8.826 0 0 1 1.016.512.761.761 0 0 1 .286.282c.073.21-.073.569-.073.569-.087.29-.702 1.55-.702 1.55a.692.692 0 0 0-.676.477.681.681 0 1 0 1.157-.252c.073-.141.141-.282.214-.431.19-.397.515-1.16.515-1.16.035-.066.218-.394.103-.814-.095-.435-.48-.638-.48-.638-.467-.301-1.116-.58-1.116-.58s0-.156-.042-.27a.688.688 0 0 0-.148-.241l.516-1.062 2.89 1.401s.48.218.583.619c.073.282-.019.534-.069.657-.24.587-2.1 4.317-2.1 4.317s-.232.554-.748.588a1.065 1.065 0 0 1-.393-.045l-.202-.08-4.31-2.1s-.417-.218-.49-.596c-.083-.31.104-.691.104-.691l2.073-4.272s.183-.37.466-.497a.855.855 0 0 1 .35-.077z" />
    </svg>
  );
}

/** Forgejo mark — git-node antlers (official monochrome path). */
export function ForgejoIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M16.7773 0c1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.1175a7.0759 7.0759 0 0 1 4.148-1.4205l.1176-.001 1.3385.0002c.4973-.8827 1.4434-1.4788 2.5288-1.4788 1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.319c.8827.4973 1.4788 1.4434 1.4788 2.5287 0 1.602-1.2986 2.9005-2.9005 2.9005-1.6018 0-2.9004-1.2986-2.9004-2.9005 0-1.0853.596-2.0314 1.4788-2.5287l-.0002-9.9831c0-3.887 3.1195-7.0453 6.9915-7.108l.1176-.001h1.3385C14.7458.5962 15.692 0 16.7773 0ZM7.2227 19.9052c-.6596 0-1.1943.5347-1.1943 1.1943s.5347 1.1943 1.1943 1.1943 1.1944-.5347 1.1944-1.1943-.5348-1.1943-1.1944-1.1943Zm9.5546-10.4644c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Zm0-7.7346c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Z" />
    </svg>
  );
}

/** Cursor Origin — official Cursor monochrome mark (Simple Icons / cursor.com
 * brand). Origin has no separate glyph, so this is the forge's brand icon. */
export function CursorOriginIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
    </svg>
  );
}

/** Azure DevOps — the Microsoft Azure "A" mark (devicon path, viewBox 0 0 128 128).
 * Drawn as one colour: the four ribbons union into the A silhouette, with the
 * counter and foot gaps left as negative space. */
export function AzureDevOpsIcon(props: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 128 128" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M46.09.002h40.685L44.541 125.137a6.485 6.485 0 01-6.146 4.413H6.733a6.482 6.482 0 01-5.262-2.699 6.474 6.474 0 01-.876-5.848L39.944 4.414A6.488 6.488 0 0146.09 0z" />
      <path d="M97.28 81.607H37.987a2.743 2.743 0 00-1.874 4.751l38.1 35.562a5.991 5.991 0 004.087 1.61h33.574z" />
      <path d="M46.09.002A6.434 6.434 0 0039.93 4.5L.644 120.897a6.469 6.469 0 006.106 8.653h32.48a6.942 6.942 0 005.328-4.531l7.834-23.089 27.985 26.101a6.618 6.618 0 004.165 1.519h36.396l-15.963-45.616-46.533.011L86.922.002z" />
      <path d="M98.055 4.408A6.476 6.476 0 0091.917.002H46.575a6.478 6.478 0 016.137 4.406l39.35 116.594a6.476 6.476 0 01-6.137 8.55h45.344a6.48 6.48 0 006.136-8.55z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// File-type glyphs. Each is a recognizable mark (braces for JSON, a terminal
// for shell, the markdown logo, …) — like the React atom for .tsx — rather
// than the extension spelled out in a box. Shared builders keep them terse.
// ---------------------------------------------------------------------------

// A genuine brand logo that happens to be lettered (TS, JS): colored square.
function brandSquare(bg: string, label: string, fg: string) {
  return (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" fill={bg} />
      <text
        x="12.25"
        y="16.4"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="9.5"
        fontWeight="700"
        fill={fg}
      >
        {label}
      </text>
    </>
  );
}

// Picture frame with a tiny landscape — shared by raster images and svg.
function imageGlyph(c: string) {
  return (
    <g fill="none" stroke={c} strokeWidth="1.6" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <circle cx="8.5" cy="9.5" r="1.7" fill={c} stroke="none" />
      <path d="M4.5 17.5l4.5-4.5 3 3 3.5-3.5 4 4" strokeLinecap="round" />
    </g>
  );
}

// Neutral folded page, tinted — the fallback for types without a logo.
function docGlyph(c: string) {
  return (
    <>
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill={c} />
      <path d="M14 3l5 5h-4a1 1 0 0 1-1-1z" fill="rgba(0,0,0,.28)" />
    </>
  );
}

// A "#" — for stylesheet languages.
function hashGlyph(c: string) {
  return (
    <g stroke={c} strokeWidth="1.7" strokeLinecap="round">
      <path d="M9.6 4.8L7.6 19.2" />
      <path d="M16.4 4.8L14.4 19.2" />
      <path d="M5.4 9.2H18.6" />
      <path d="M4.9 14.8H18.1" />
    </g>
  );
}

// "</>" — for markup/template languages.
function codeGlyph(c: string) {
  return (
    <g fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 8L4 12l4 4" />
      <path d="M16 8l4 4-4 4" />
      <path d="M13.5 6.5L10.5 17.5" />
    </g>
  );
}

const SETTINGS_COG =
  "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z";

// Tint for the folded-page fallback, by extension. No logo, just a color.
const DOC_TINT: Record<string, string> = {
  py: "#4b8bbe", go: "#46b5d1", rb: "#c0392b", java: "#b07219", kt: "#a97bf0",
  swift: "#f05138", c: "#5a78b0", h: "#5a78b0", cpp: "#5a78b0", cc: "#5a78b0",
  hpp: "#5a78b0", cs: "#68217a", php: "#7377ad", lua: "#5b6bd6", dart: "#0a99c4",
  ex: "#9b7bc0", exs: "#9b7bc0", txt: "#9aa0aa", csv: "#5a9b6b", tsv: "#5a9b6b",
  graphql: "#e535ab", gql: "#e535ab", proto: "#7a8ab5", env: "#d6b73c",
  gitignore: "#e8693f", gitattributes: "#e8693f", gitmodules: "#e8693f",
  license: "#9aa0aa", dockerfile: "#3a8cc4", makefile: "#8a8f99",
};

/** Returns the inner SVG glyph for a file extension (or whole filename for
 * extensionless files). Recognizable logos first; tinted page as fallback. */
function glyphFor(ext: string) {
  switch (ext) {
    case "tsx":
    case "jsx": {
      const c = "#61dafb";
      return (
        <>
          <circle cx="12" cy="12" r="1.9" fill={c} />
          <g stroke={c} strokeWidth="1" fill="none">
            <ellipse cx="12" cy="12" rx="10" ry="4.2" />
            <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(60 12 12)" />
            <ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(120 12 12)" />
          </g>
        </>
      );
    }
    case "ts":
    case "mts":
    case "cts":
      return brandSquare("#3178c6", "TS", "#fff");
    case "js":
    case "mjs":
    case "cjs":
      return brandSquare("#f7df1e", "JS", "#111");
    case "json":
    case "jsonc":
    case "json5":
      return (
        <>
          <g fill="none" stroke="#cbcb41" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.2 4.5C7.6 4.5 7.1 5.4 7.1 6.9c0 1.2.2 2.3-.5 3.2-.3.45-.85.7-1.3.9.45.2 1 .45 1.3.9.7.9.5 2 .5 3.2 0 1.5.5 2.4 2.1 2.4" />
            <path d="M14.8 4.5c1.6 0 2.1.9 2.1 2.4 0 1.2-.2 2.3.5 3.2.3.45.85.7 1.3.9-.45.2-1 .45-1.3.9-.7.9-.5 2-.5 3.2 0 1.5-.5 2.4-2.1 2.4" />
          </g>
          <circle cx="12" cy="12" r="1.15" fill="#cbcb41" />
        </>
      );
    case "md":
    case "mdx":
    case "markdown":
      return (
        <g fill="none" stroke="#519aba" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="5.5" width="19" height="13" rx="2.2" />
          <path d="M6 15.5V9.2l3 3.4 3-3.4v6.3" />
          <path d="M16.4 9.2v5.8m0 0l-2-2.1m2 2.1l2-2.1" />
        </g>
      );
    case "css":
      return hashGlyph("#42a5f5");
    case "scss":
    case "sass":
      return hashGlyph("#cd6799");
    case "less":
      return hashGlyph("#2a6db5");
    case "html":
    case "htm":
      return codeGlyph("#e44d26");
    case "xml":
    case "plist":
      return codeGlyph("#b0905a");
    case "vue":
      return (
        <>
          <path d="M2.5 4.5h4L12 13.2 17.5 4.5h4L12 21z" fill="#41b883" />
          <path d="M6.5 4.5h3L12 8.8l2.5-4.3h3L12 15.8z" fill="#35495e" />
        </>
      );
    case "svg":
      return imageGlyph("#cf913b");
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "ico":
    case "icns":
    case "avif":
    case "tiff":
    case "heic":
      return imageGlyph("#a877d6");
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
    case "ps1":
    case "bat":
    case "cmd":
      return (
        <>
          <rect x="2.5" y="4" width="19" height="16" rx="2.6" fill="#33373f" />
          <path d="M6 9l3 3-3 3" fill="none" stroke="#5af78e" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11.8 15.5h4.2" stroke="#5af78e" strokeWidth="1.7" strokeLinecap="round" />
        </>
      );
    case "sql":
    case "db":
    case "sqlite":
      return (
        <g fill="none" stroke="#dba617" strokeWidth="1.6">
          <ellipse cx="12" cy="6" rx="6.5" ry="2.6" />
          <path d="M5.5 6v12c0 1.45 2.9 2.6 6.5 2.6s6.5-1.15 6.5-2.6V6" />
          <path d="M5.5 12c0 1.45 2.9 2.6 6.5 2.6s6.5-1.15 6.5-2.6" />
        </g>
      );
    case "yml":
    case "yaml":
    case "toml":
    case "ini":
    case "conf":
    case "cfg":
    case "editorconfig":
    case "properties":
      return <path d={SETTINGS_COG} fill="#8f86d6" />;
    case "rs":
      return <path d={SETTINGS_COG} fill="#d98a5a" />;
    case "lock":
      return (
        <g fill="none" stroke="#9aa0aa" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
          <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        </g>
      );
    case "pdf":
      return docGlyph("#c0392b");
    case "zip":
    case "tar":
    case "gz":
    case "tgz":
    case "rar":
    case "7z":
    case "xz":
    case "bz2":
      return (
        <g fill="none" stroke="#c8a04e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.7 7.6L12 3l8.3 4.6v8.8L12 21l-8.3-4.6z" />
          <path d="M3.7 7.6L12 12.2l8.3-4.6M12 12.2V21" />
        </g>
      );
    default:
      return docGlyph(DOC_TINT[ext] ?? "#7e8696");
  }
}

/** File-type icon: a recognizable glyph per type (the React atom for .tsx,
 * braces for JSON, a terminal for shell, …) — never the bare extension as
 * text. Unknown types fall back to a neutral tinted page. */
export function FileIcon({ path, size = 18 }: { path: string; size?: number }) {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  // Extensionless/dotfiles (e.g. "dockerfile", ".gitignore") key on the whole
  // name, which is what split(".").pop() yields for them.
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : name;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: "none" }} aria-hidden="true">
      {glyphFor(ext)}
    </svg>
  );
}

export function PullRequestIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v10" />
      <path d="M18 16V9a3 3 0 0 0-3-3h-2" />
      <path d="m13 3-3 3 3 3" />
    </IconBase>
  );
}

export function GitBranchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </IconBase>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </IconBase>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
    </IconBase>
  );
}
