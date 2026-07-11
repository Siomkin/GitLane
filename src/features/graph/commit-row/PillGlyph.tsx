import { TreeIcon } from "../../../components/ui/icons";
import type { RefPillIcon } from "./refPillModel";

/** The ref-pill glyphs, keyed by the model's icon discriminant. Shared by
 * RefPill and CombinedRefPill — the check/tree/fork SVGs used to be duplicated
 * between them. Color comes from the pill's text color except the neutral
 * worktree/fork glyphs (accent is reserved for the active state). */
export function PillGlyph({ icon }: { icon: RefPillIcon }) {
  switch (icon) {
    case "current":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3 w-3 shrink-0">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "tag":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
          <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
          <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
        </svg>
      );
    case "remote":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0">
          <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9.5 4 4 0 0 0 7 17.5" />
        </svg>
      );
    case "worktree":
      // Checked out in another worktree → the worktree glyph instead of the
      // plain branch fork. Neutral (not accent): accent is reserved for the
      // *active* worktree, and this branch lives in a non-active one.
      return <TreeIcon className="h-3 w-3 shrink-0 text-neutral-400" />;
    case "branch":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3 w-3 shrink-0 text-neutral-400">
          <path d="M6 3v15M18 9a9 9 0 0 1-9 9" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
        </svg>
      );
  }
}
