import { RowKind } from "@/components/navigation/branch-navigator/refs";

/** The leading glyph: a check for the checked-out branch, otherwise a kind-specific
 * monochrome icon (branch fork / cloud / tag), matching the design. */
export function RowGlyph({ kind, current }: { kind: RowKind; current: boolean }) {
  if (current) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 shrink-0">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (kind === RowKind.Remote) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
        <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
      </svg>
    );
  }
  if (kind === RowKind.Tag) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
        <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
        <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5 shrink-0 text-neutral-400">
      <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
    </svg>
  );
}
