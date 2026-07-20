// Folder module for the navigator's row contracts (GL-192): one file per row —
// branch/remote/tag, worktree, and stash rows each own distinct navigation,
// menu, and keyboard behavior. RowGlyph and the shared DIM token stay internal.
// The old single-file `rows.tsx` import path resolves here unchanged.
export { SectionHeader } from "./SectionHeader";
export { BranchRow } from "./BranchRow";
export { WorktreeRow } from "./WorktreeRow";
export { StashRow } from "./StashRow";
