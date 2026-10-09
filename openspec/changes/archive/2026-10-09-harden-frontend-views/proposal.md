# Proposal

## Why

The 2026-09-28 round-2 audit (`AUDIT.md`) found frontend problems where a view, a store
action and its siblings disagree, plus leftovers from seven round-1 fixes (A2-7, A3-13,
A5-7, A5-8, A6-10, A6-11, A6-13, A8-6, A8-7, A8-16):

- One Escape in Settings over the onboarding overlay closes both, and during a clone it
  cancels the clone (item 2, P0).
- Recent worktree entries lose their repository identity on every restart (item 11).
- The title-bar Search does nothing while a review, compare or file view is open (item 13).
- In the conflict editor, "theirs" is hard-coded to the Blue accent (item 12).
- A failed stash/worktree read on repo open shows "none" instead of "unavailable" (29).
  The conflict runners misread a refresh that was deferred behind a Fetch (30). The stacked
  review's Graph button and file-list error are wrong (39, 40). ⌘S fails on non-Latin
  layouts (38).

No Jira issue exists yet.

## What Changes

- Overlays and routing: onboarding joins ModalFrame's Escape stack (2). Title-bar Search
  (13) and the stacked review's Graph button (39) use `returnToGraph()`. `deriveCenterView`
  moves down to `src/store/centerView.ts` (37). ⌘S uses the shortcut registry (38).
- Store: persist recents' `mainPath` (11), report open-path section failures (29), branch
  on the deferred-refresh result (30), and `commitIdentityFields` as a parameter object (63).
- Forge-aware views read `RepoForge.capabilities`, not kind lists (31). One forge icon
  table (36). The `hostEyebrow`/`hostLinks` rename (41).
- Theming: accent-aware graph ring and drop target (32), no `--accent-soft` override in the
  conflict view (33), and `focusRing` on review, inspect and file-view buttons (79).
- Correct counts and labels: distinct-path change count (34), "default remote" wording and
  one `defaultRemoteName` helper (35, 50), an error row for the stacked-review list (40), and
  the merge-menu delete flag (67).
- Duplicates and dead code: `useCopyFeedback` (46), shared icons (47), one working-union
  count (48), shared worktree-dirty wording (51), one `migratePathKey`/`writeJsonMap`/
  `RefreshScope` (52), one file-view line cap (53), and the round-1 leftovers (42, 43, 44).
  Dead store/lib members (59, except the OAuth pair), null tolerance behind zod (60),
  required TS booleans (66), `FileIcon` out of the `icons.tsx` exemption (80), and the frontend
  comments (81).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chrome/overlays`: Escape closes only the topmost layer, including the onboarding
  overlay; Search and the stacked review's Graph button reach the graph from any view;
  shortcuts match by physical key.
- `chrome/repo-tabs`: recent worktree entries keep their repository name and group across
  restarts.
- `worktrees/stashes`: a failed stash or worktree read on open is shown as unavailable.
- `review/diff`: a failed stacked-review file list is shown as an error with Retry.
- `changes/patch-staging`: the working-changes count counts each file once.

## Non-goals

- Backend items (`harden-forge-providers`, `harden-git-core`). IPC items owned there bring
  their own frontend tasks.
- The decisions in design.md (items 12, 49, and the OAuth pair in 59) get no task until
  decided.

## Impact

- **Processes:** frontend only (`src/`), plus `docs/rules/architecture-rules-react.md:304`
  (item 81).
- **Layering:** item 37 moves a pure module from `app-shell` into `store`. ESLint layer
  rules and `bun run cycles` must stay green.
- **Persistence:** item 11 adds `mainPath` to the stored recents, and old entries still
  read. Item 59 removes three persisted keys (`collapsed`, `branchWidth`, `whenWidth`), and
  the persist `merge` ignores unknown keys.
