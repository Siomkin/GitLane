# Tasks

## 1. Rust dead code and stale docs (A1-11, A1-12, A1-13, A1-17, A2-16, A2-17, A3-13, A3-15, A3-19, A3-21)

- [x] 1.1 Remove `HeadLease`'s serde derives and wire test, `CleanupKind` and `include_ignored`, the `commands/github.rs` `blocking_tests` module, the unused `discard_file` Windows imports, the no-op Origin test, the unreachable `transport_auth` arm, and the unused `into_detail` `commits` parameter; reuse `DIFF_STDOUT_LIMIT`. Verify with `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test`.
- [x] 1.2 Make `build_profiled`/`GraphBuildMetrics` `#[cfg(test)]` (or delete them), and apply the A3-21 small items; verify with `cargo test graph`.
- [x] 1.3 Correct the stale comments listed in A2-16, A3-13 and A3-15, and remove the dead lint `allow`; verify with `rg` for each corrected phrase.

## 2. Frontend dead code (A4-8, A5-5, A6-13, A6-14, A8-9, A8-10)

- [x] 2.1 Remove `credential_helper_status` across all four layers (impl, command + `generate_handler!` line, type, TS wrapper); verify that `cargo test registration_tests` and `bunx tsc --noEmit` pass.
- [x] 2.2 Delete the remaining zero-reference symbols listed in A4-8, A5-5, A6-13, A8-9 and A8-10 after re-running the grep proof, and move the orphaned doc comments (A6-14); verify with `bun run lint`, `bun run test` and `bun run build`.

## 3. Native-OAuth UI (A8-8)

- [x] 3.1 Delete the zero-reference helpers `OAUTH_PROVIDERS`, `isOauthProvider`, `useOauthConfigured`, `StateBlock` and `ShieldIcon`; verify with `bunx tsc --noEmit`. — already on latest (e0bd6db7, #448)
- [x] 3.2 Decided in #448 (e0bd6db7): `OauthMethod.tsx` deleted, `overlays/provider-oauth/*` kept as a future entry point, docs updated to say the in-app sign-in is not wired. Was: once the maintainer decides: either (b) delete `OauthMethod.tsx`, `overlays/provider-oauth/*` and the `SettingsModal` clause, and correct CLAUDE.md plus `docs/provider-oauth-setup.md`; or (a) open a separate spec-bearing change to re-expose it. Verify with `rg -w OauthMethod src` returning nothing (b), or the new change existing (a).

## 4. Stale comments and copy (A4-10, A7-15, A8-17, A8-18)

- [x] 4.1 Fix the IPC-seam comments and import `assertEqual` in `events.ts`, rewrite the stale store comments and inline the three `*RemoteHosts` wrappers, drop the stale menu lint allowlist entries, and change About to "Visual git client"; verify with `bun run lint` and `bun run test`.

## 5. Pure duplicates (A5-6, A5-8, A5-9, A5-11, A6-6, A6-7, A6-8, A6-10, A6-12, A7-9, A7-10, A7-11, A7-16, A8-12, A8-14, A8-15, A8-19)

- [x] 5.1 UI primitives: settings draft-list primitives, icons from `components/ui/icons`, `LoadError` via `ErrorFallback`, `OutcomeBadge` plus the large frame buttons, `useWindowMaximized`, and the `AgentRunStatus` action slot; verify with the affected component tests.
- [x] 5.2 Feature helpers: the `NAV_CATEGORIES` descriptor, keyed state instead of reset-only effects, `stashEntryFromNode`, one `lib/pathTree.ts`, history-inspect reusing `ErrorState`/`RevisionInspector`/`DiffTruncatedNotice`, `slugOf`/`repoLabel` in `lib`, and `openRepoSettings(section?)`; verify with `bun run test`.
- [x] 5.3 Store: `repoDataWipe` for the carry list, one `RepoReadOwner`, `requestLease` everywhere (including `generations.ts`), `runBatchPick` / `reselectAfterPatch` / `fetchSelectedFileDiff`; verify with the store test suite and `bun run cycles`.

## 6. Integration

- [x] 6.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`; all exit 0.
- [ ] 6.2 In `bun run tauri dev`, click through Settings (Accounts, Identity, Remotes), the branch navigator, and a remove-worktree dialog, and confirm nothing regressed. — manual, pending

## Notes

Re-ran the grep proof (`rg -w <symbol> src src-tauri docs scripts` plus `generate_handler!` / `invoke("…")`) before each deletion. Deviations and items already gone:

- **Already on latest** (removed by #444–#449 or the stacked commits): `noreplyEmail`, `addAgent` / `duplicateAgent` / `addAiActionCommand` / `aiActionsValid`, `graphViewport.ts`, `commitMeta.ts`, `knownCommitAgent`, the `composeAgentMessage` `_branch` param, `settings/identity.ts`, `connectState` / `ConnectState`, `canCreatePullRequest`, the LeftPanel Origin branch, the gitlab `ops.rs` rebase comment and the `service.rs` key list (A2-16), the `new_path.rs` "synchronous" comment (A3-15), and the `build_profiled` re-exports being `#[cfg(test)]`.
- 1.1 `HeadLease`: serde derives, renames and wire test removed; doc now says it never crosses IPC.
- 1.1 `CleanupKind`: enum, field, filter and `include_ignored` removed. The snapshot hash still feeds the same constant `0` byte the one-arm match produced, so tokens are unchanged.
- 1.1 The unreachable `transport_auth` arm stays as `unreachable!()`: the second `match` must stay exhaustive.
- 1.1 `windows_message_is_origin_specific` deleted rather than converted to a `cfg(windows)` assertion.
- 1.1 `detail_stats` extraction (A2-17's second half) not done — not in the task text.
- 1.2 `build_profiled` / `GraphBuildMetrics` kept: the benchmark exists (`bun run bench:graph` → ignored `benchmark_fixture` test, `docs/graph-performance.md`). The re-exports now carry only `build_profiled` (no `#[allow(unused_imports)]`) and the doc names the benchmark. Production `build` shares the one body.
- 1.2 A3-21: `terminal_agents::probe` inlined into a `pub probe_available` (callers in `commands/terminal.rs`, `acp_agents.rs`, `acp/catalogue.rs` updated); `git_config_get_all` / `_regexp` collapsed into `git_config_get(flag, arg)`.
- 1.3 A3-13 handled as a doc fix only (Rust `is_default` + TS `RemoteInfo.isDefault`: "default (fetch/upstream) remote"); badge behaviour unchanged.
- 2.1 `CredentialHelperStatus` struct kept (the save/forget flows read it in-process); its `Serialize` derive and `types/auth.rs` re-export dropped, and the serialization half of the sanitizer test replaced by an assertion on the labels (test renamed).
- 2.2 `prSupportedFor` kept: after `declare-forge-capabilities-once` it reads the `PROVIDERS` table and has a real caller (ForgeConnect), so it is not the middle man the audit saw. `isPrForge` removed (callers use `supportsPullRequests`).
- 2.2 `rowStyles.ts` deleted whole (it held only `DIM_CLASS`). `requiresForce` also dropped from `RemoveWorktreeSubject` (nothing reads it once `force` is gone). `modEnter` → `formatShortcut(ShortcutId.SubmitForm, isMac)` (identical output). The LeftPanel `"gh) not found"` rewrite dropped: the backend already sends that copy.
- 2.2 `CredentialEntryForm` is helper-only now: the keychain segment, `saveProviderToken` branch and "Store in keychain" copy were unreachable (both callers passed `helperOnly`).
- 4.1 The forgeAuth whoami-list comment moved onto `FORGE_WHOAMI_PROVIDERS` in `lib/forgeHelp.ts`, where the list lives.
- 5.1 `useWindowMaximized` + `currentWindow()` live in `components/chrome/useWindowMaximized.ts`; the resize grips keep their own one-line `setDecorations(false)` mount effect.
- 5.1 `LoadError` now renders `ErrorFallback` (`retryLabel="Retry"`), so the PR tabs' load errors gain `role="alert"` and the shared `focusRing` — intended.
- 5.1 Icons: `terminalIcons.tsx` deleted — Expand / Collapse / Restore and the tab's `>_` glyph (`TerminalPromptIcon`) moved into `components/ui/icons`; Close / Plus use the shared icons with the old size and stroke. The inline warning / plus / search SVGs, `DuplicateGlyph` (→ `CopyIcon`), onboarding `ChevronRight` / `PlusGlyph` / `WarningTriangle`, and RowGlyph's branch / tag use the shared icons at their old stroke widths.
- 5.1 **Redrawn glyphs replaced (pixel changes — check in 6.2):** terminal Clear and the agent-row Delete → `TrashIcon`; agent-row Edit → `EditIcon`; onboarding `CheckGlyph` / `CheckSmall` and RowGlyph's current-branch check → `CheckIcon`; the inline warning triangles gain round caps and `WarningIcon`'s 3.7 apex. RowGlyph's remote cloud stays local: `RemotesIcon` adds a download arrow, so it is a different glyph.
- 5.1 A5-6: `moveItem<T>` (in `terminal/agentDraft.ts`) replaces `moveAgent`, `moveAiActionCommand` and the inline ACP splice; `isAgentValid` is structural and replaces `isAiAgentValid` plus the three inline copies; the drag lift is `DRAG_LIFT_STYLE` / `DRAG_CARD_CLASS` in `agentRowParts.tsx`. The `editingIds` Set boilerplate was left alone.
- 5.1 A6-12: `AgentRunStatus` takes `action` and `className` (default `mt-2`); the composer's Draft row uses it, so that row is now a `<p>` like the others. `DraftAgentControl`'s comments say ACP agents.
- 5.1 A8-12: `OutcomeBadge` (in `overlays/progress`) replaces the five badge ternaries. The large footer buttons are class constants (`LARGE_PRIMARY_BUTTON` / `LARGE_SECONDARY_BUTTON` / `LARGE_DANGER_BUTTON` in `dialogs/frame.tsx`) rather than components, so callers keep their refs; they add the missing `focusRing` — intended. `displayUrl` and the device-flow labels (`deviceFlowStepLabel`, replacing `signinStepLabel`) moved to `overlays/progress`. The three done-focus effects were left alone.
- 5.2 A8-19: `webUrlSlug` in `lib/paths`; `repoLabel(path, fallback = "Repository")` now splits on `/` and `\` (as `trimTrailingSeparators` already trimmed both), and the Repository-settings rail and the Remotes header pass `"this repository"`, so each site keeps its text. `slugOf` keeps its exact host fallback.
- 5.2 A6-10: BlameView uses `ErrorState` (new `title` prop) and `InspectorAction`; `RevisionInspector` takes a `FileHistoryEntry`, so the blame inspector's container stays. DiffPane uses `DiffTruncatedNotice` with its old message — the banner style changes to the review one.
- 5.2 A6-8: one `lib/pathTree.ts` (`buildPathTree` / `walkPathTree` / `pathTreeItems`) under both trees. The shared presentational rows are not extracted (design prose, not in the task).
- 5.2 A5-11: `NAV_CATEGORIES` in `refs.ts` feeds the sidebar, nouns, counts and visible counts; `buildNavItems` and `canCreate` were not rewritten.
- 5.2 A6-6: new `hooks/useKeyedState` replaces the reset-only effects in `useFileFilter`, `useWorkingTreeDiffs` and `FilesPanel`. Not converted: `useCommitExecutionController`'s `amend` clamp (deriving it would re-enable amend when `canAmend` returns; keying it would invent a key) and `StackedReview`'s selection-driven expand, which is not a reset.
- 5.3 A7-9: `carriedRepoData(get())` carries the transport/session four at all five wipe sites; `recents` / `fileSelectionRequestId` stay per site.
- 5.3 A7-10: the three local `ReadOwner`s are now `RepoReadOwner`; the optional `claimReadOwner` was skipped.
- 5.3 A7-11: every hand-rolled counter is a `requestLease()` (`repoFilesActions` ×5, `repoSelectionDiff`, `accounts`, `ghAccounts`, `forgeAuth`, `identities/writeQueue`). `generations.ts` keeps its `claimList` / `listGeneration` / `invalidate*` interface over leases, so its 34 call sites did not move.
- 5.3 A7-16: `runBatchPick` + `clearSelectionIfCurrent` (history), `reselectAfterPatch` (staging) and `fetchSelectedFileDiff` (commits; `full` stays `undefined` for `selectFile` so the IPC payload is unchanged).
- 6.1 All nine checks exit 0 (logs `c6-*.log` in the session scratchpad). The first clippy run failed on the test module's now-unused `CredentialHelperStatus` import; removed. `cargo test`: 1250 passed, 2 ignored.

