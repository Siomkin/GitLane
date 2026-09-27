import { CheckIcon, GitBranchIcon, TagIcon } from "@/components/ui/icons";
import { RowKind } from "@/components/navigation/branch-navigator/refs";

/** The leading glyph: a check for the checked-out branch, otherwise a kind-specific
 * monochrome icon (branch fork / cloud / tag), matching the design. */
export function RowGlyph({ kind, current }: { kind: RowKind; current: boolean }) {
  if (current) {
    return (
      <CheckIcon strokeWidth={2} className="h-3.5 w-3.5 shrink-0" />
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
      <TagIcon strokeWidth={1.7} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
    );
  }
  return (
    <GitBranchIcon strokeWidth={1.7} className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
  );
}
