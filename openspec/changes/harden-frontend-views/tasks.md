# Tasks

## 1. P0/P1 behaviour (AUDIT items 2, 11, 13)

- [x] 1.1 Export `useEscapeOwner` from `overlays/dialogs/frame.tsx`, use it in `ModalFrame` and `RepoOnboarding`; verify with a render test that Escape in Settings over the onboarding overlay closes Settings only, and a second Escape closes the overlay.
- [x] 1.2 Persist and read `mainPath` in `store/repoSession.ts`; verify with a round-trip test and one that loads an old entry without the field.
- [x] 1.3 Call `returnToGraph()` from the title-bar Search; verify with a test that Search from a stacked review shows the history view with the search bar open.

## 2. Store actions (items 29, 30, 63)

- [x] 2.1 Call `reportSectionFailure` in each open-path catch in `repoLifecycle/sideEffects.ts` under the request guard; verify with a test where `listStashes` rejects on open.
- [x] 2.2 Branch on the refresh result in `runMaybeConflict` and `runOperation`, and drop the eager `operation: null`; verify with a test that runs a conflicting merge while `loading` is held.
- [x] 2.3 Add `commitIdentityFields(identity)` and use it at the six sites; change `continueOperation`/`skipOperation` to take one `identity`.

## 3. Views and routing (items 37, 38, 39, 40, 34, 67)

- [x] 3.1 Move `deriveCenterView` + `centerViewInputOf` to `src/store/centerView.ts` and use it from `useCenterView` and `useShortcuts`; verify that `bun run lint` and `bun run cycles` pass.
- [x] 3.2 Match ⌘S with `matchesEvent(SAVE, e, isMac)` in `FileEditor.tsx`; verify with a test using `code: "KeyS"` and `key: "ы"`.
- [x] 3.3 Use `returnToGraph()` for the stacked review's Graph button, and add a `listError` state with Retry; verify both with render tests.
- [x] 3.4 Count distinct paths in the `WorkingInspector` header; verify with a partly staged file.
- [x] 3.5 Use `allowDeleteBranch && deleteBranch` in `PrMergeMenu`.

## 4. Forge-aware views (items 31, 36, 41)

- [x] 4.1 Gate create-PR stacking, toolbar polling and the indicator title on `forge.capabilities`; verify with a fixture forge whose capabilities differ from its kind.
- [x] 4.2 Carry `headerForge` in the popover model and render `ForgeIcon`, and drop `FORGE_ICON_KEY`/`headerIcon`; rename `githubEyebrow`/`githubLinks` to `hostEyebrow`/`hostLinks`.

## 5. Theming and labels (items 32, 33, 35, 50, 79)

- [x] 5.1 Read the selected-node ring from `--accent` and add one `DROP_TARGET_RING` class for the three rows; delete the `--accent-soft` override in `ConflictWorkspace`.
- [x] 5.2 Reword "default push remote" to "default remote" at the sites in AUDIT item 35; add `defaultRemoteName(remotes)` and pass the resolved remote from `TagContextMenu`.
- [x] 5.3 Add `focusRing` to the review, inspect and file-view buttons (via `modeButton`, `subButton`, `segBtn`, `rowBase`).

## 6. Duplicates and dead code (items 42–44, 46–48, 51–53, 59, 60, 66, 80, 81)

- [x] 6.1 Replace the hand-rolled copy buttons with `useCopyFeedback` (AUDIT 46) and the inline SVG copies with `icons.tsx` components (47).
- [x] 6.2 Extract `workingUnionReview` (48), share the worktree-dirty helpers (51), keep one `migratePathKey`/`writeJsonMap`/`RefreshScope` (52), one `FILE_VIEW_MAX_LINES` (53), `CommitSummaryCard` (43), the shared `formatBytes` (44), and drop `composeAgentMessage`'s `_branch` (42) and correct `prune-dead-code-and-duplicates/tasks.md:38`.
- [x] 6.3 Delete the dead members in AUDIT item 59 (except `oauthClientStatus`/`setOauthClientId`) and their tests, remove the three persisted keys, and remove the null tolerance in item 60.
- [x] 6.4 Make the six booleans in AUDIT item 66 required and fix fixtures; move `FileIcon` to `components/ui/FileIcon.tsx` (80); fix the comments in item 81, including `docs/rules/architecture-rules-react.md:304`.

## 7. Verify

- [x] 7.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, and `openspec validate harden-frontend-views --strict` all pass.
- [ ] 7.2 In `bun run tauri dev`: open Settings from a clone error and press Escape; restart and check worktree recents are grouped; switch the accent to Blue and Red and look at the graph and the conflict editor. — manual
