// Pure conflict-marker model for the in-app editor — no React, no IPC, so it's
// trivially testable. The backend (`git::conflicts::conflict_file`) hands us the
// worktree copy of a conflicted file *with* git's `<<<<<<< / ======= / >>>>>>>`
// markers; this module parses it into hunks, reconstructs the merged text from
// the user's per-hunk choices, and provides lightweight syntax tokenization for
// the diff rows. The component layer is a dumb painter over these outputs.
//
// Split by what each part does: the shapes (`types`), reading a conflicted file
// (`parse`), resolving it (`decisions`), the per-line editor (`lineEditor`), and
// pane tokenisation (`tokenize`).

export * from "./conflictModel/types";
export * from "./conflictModel/parse";
export * from "./conflictModel/decisions";
export * from "./conflictModel/lineEditor";
export * from "./conflictModel/tokenize";
