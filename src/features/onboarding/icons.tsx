// Onboarding glyphs, traced to match the RepoOnboarding mockup exactly (stroke
// weights and paths). Kept local to the feature so the screens stay visually
// faithful and self-contained; size them with Tailwind `w-/h-` classes.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number };

function Base({ children, strokeWidth = 1.7, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/** Download-into-tray — the clone action. */
export function CloneIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 3v10m0 0 4-4m-4 4-4-4" />
      <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    </Base>
  );
}

/** Folder with a plus — the initialize action. */
export function NewRepoIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
      <path d="M12 11v6M9 14h6" />
    </Base>
  );
}

/** Plain folder — open local / destination fields. */
export function FolderGlyph(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
    </Base>
  );
}

/** Git-branch glyph used in the branch pills. */
export function BranchPillIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="M6 3v12" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Base>
  );
}

export function ChevronRight(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="m9 18 6-6-6-6" />
    </Base>
  );
}

export function ChevronLeft(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="m15 18-6-6 6-6" />
    </Base>
  );
}

/** Open ring — spun via an `animate-spin`/inline style by the caller. */
export function SpinnerRing(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
    </Base>
  );
}

export function CheckGlyph(props: IconProps) {
  return (
    <Base strokeWidth={2} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Base>
  );
}

/** Bold check for the inline "URL looks good" affordance. */
export function CheckSmall(props: IconProps) {
  return (
    <Base strokeWidth={2.2} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Base>
  );
}

/** Alert circle for the inline "URL invalid" affordance. */
export function AlertCircle(props: IconProps) {
  return (
    <Base strokeWidth={2.2} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </Base>
  );
}

/** Warning triangle — hard clone failures. */
export function WarningTriangle(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    </Base>
  );
}

/** Crossed circle — a benign cancel. */
export function XCircle(props: IconProps) {
  return (
    <Base strokeWidth={1.8} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </Base>
  );
}

/** Counterclockwise arrow — retry. */
export function RetryIcon(props: IconProps) {
  return (
    <Base strokeWidth={1.9} {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </Base>
  );
}

export function PlusGlyph(props: IconProps) {
  return (
    <Base strokeWidth={1.9} {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

/** Folded document — the README option. */
export function DocIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 4h11l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M14 4v5h5" />
    </Base>
  );
}
