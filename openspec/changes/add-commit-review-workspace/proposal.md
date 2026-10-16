# Proposal

## Why

Reviewing and shaping a commit in GitLane today means moving between the Changes workspace
(per-file staging review), separate staged/unstaged diffs, and the commit modal. There is no
single surface where the user sees each file as "HEAD vs what I have now", ticks the
differences that belong in the commit, reverts the ones that do not, fixes a line in place,
and commits. This change turns the Changes view into that surface.

Jira: none yet.

## What Changes

- The Changes tab becomes a **commit review workspace** in its existing layout: the single-file
  review in the center shows the selected file's diff with previous/next difference and file
  navigation and an "N differences, M included" count; the Working Changes panel on the right keeps
  the file list and commit composer and gains an Include / Staging-area switch.
- **Include view (default)**: each file shows one diff of HEAD against the working tree, split
  into differences (contiguous change blocks). Each file and each difference has an include
  checkbox whose state is read from the git index (included / excluded / partly included).
  Toggling a checkbox stages or unstages exactly that file or difference immediately.
- **Staging-area view (toggle)**: the current staged / unstaged split review, per-hunk and
  per-line stage/unstage, as today's `ChangesWorkspace` behaves.
- **Revert an excluded difference** (`>>`): restores that block of the working tree to the
  index content. Offered only on differences with no staged part in v1.
- **Whole file, side labels, word highlights**: the Include diff can show every line of the file,
  labels its split sides (HEAD / Working tree), and changed words are highlighted within lines.
- **Editable current side**: the working-tree side of the diff can be edited and saved in
  place (⌘S / Ctrl-S), with the existing stale-file guard.
- **New write operations** (Rust + IPC): stage/unstage a contiguous line range of a diff in one
  operation, and reverse-apply a line range to the working tree. Both refuse stale selections.
- **New read** (Rust + IPC): per-file HEAD-vs-working-tree differences annotated with their
  index inclusion state.
- The surface takes only a repository path and store state — no dependency on the main
  window grid — so a later change can host it in its own OS window.

Touches: Rust (read + write), IPC (new commands), frontend (Changes workspace, review diff,
editor reuse).

## Non-goals

- A separate OS window / second webview (later change; needs multi-webview store sync and a
  capability decision in `docs/tauri-plugin-decisions.md`).
- An inclusion selection kept outside the index (changelists / a temporary index at commit
  time). The git index stays the single source of truth; the terminal always agrees with the
  checkboxes.
- Reverting a difference that is fully or partly staged (touches index and working tree).
- Pre-commit "commit checks" (reformat, analyze code, TODO check).
- Editing files with mixed line endings (they open read-only; LF and CRLF files keep their style).
- Replacing the History-mode `RightPanel` quick commit or the commit modal reached from it.

## Capabilities

### New Capabilities

- `changes/commit`: the commit review workspace — include/staging-area views over the git
  index, per-difference inclusion, revert of excluded differences, in-place editing,
  navigation and commit from one surface.

### Modified Capabilities

- `changes/patch-staging`: adds range staging/unstaging and working-tree reverse-apply of a
  line range, under the existing byte-exact and stale-selection guarantees.
- `review/diff`: highlights the changed words within paired removed/added lines in the single-file
  review's split and unified diffs.

## Impact

- Rust reads: a new differences-with-inclusion read beside the base-to-working-tree diff in
  `src-tauri/src/git/status/compare.rs` (libgit2).
- Rust writes: range apply / range revert in `src-tauri/src/git/write/patch_staging/`
  (git CLI `git apply`, copying `apply.rs` / `extract.rs`).
- IPC: new commands in `src-tauri/src/commands/staging.rs` (+ `generate_handler!`), types
  under `git/types/`, wrappers in `src/lib/api/git/`.
- Frontend: `features/changes/WorkingInspector` (Include / Staging switch, three-state combined
  list), `features/review/ReviewWorkspace` + a new `IncludeDiffPane` (`SplitDiff` / `UnifiedDiff`
  gutter controls), `repo-files/file-workspace/FileEditor` (reused for the editable side),
  `src/lib/shortcuts.ts` (navigation chords). The stacked "review all" view is unchanged.
- Store: repo-store actions for the new operations; persisted view switch in `src/store/ui/appearance.ts`.
- No secrets, auth, new dependency, plugin, capability, or CSP change.
