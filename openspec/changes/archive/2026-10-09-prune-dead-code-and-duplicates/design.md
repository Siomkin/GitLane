# Design

## Context

See proposal.md (Why). The grep proof and the `path:line` for every item are under
**Findings**. This change contains no engine or store-ownership changes.

## Goals / Non-Goals

**Goals:** delete what nothing reaches, fix what comments claim, and collapse copies that
must change together.

**Non-Goals:** behaviour changes and the Rust OAuth flows.

## Decisions

1. **Re-run the grep proof before deleting anything.** For each symbol, first run
   `rg -w <symbol> src src-tauri docs scripts` together with the `generate_handler!` /
   `invoke("…")` string check. Delete only if it still shows zero consumers.
2. **`credential_helper_status` removal is a four-layer change.** It covers the impl, the
   `commands/*.rs` fn plus its `lib.rs` `generate_handler!` line, the type re-export, and
   the TS wrapper. `registration_tests` must still pass.
3. **Needs a decision: native-OAuth UI (A8-8).**
   - (a) Re-expose `OauthMethod` from `ForgeConnect.tsx`. This makes the docs true again
     and needs a spec delta on `accounts/transport`, so it moves to its own change.
   - (b) Delete `OauthMethod.tsx`, `overlays/provider-oauth/*`, the `SettingsModal`
     suspension clause, and the dialog slice fields, and correct CLAUDE.md plus
     `docs/provider-oauth-setup.md`.
   Whichever is chosen, delete the zero-reference helpers now.
4. **Dedupe by extracting into the existing home.** `lib/paths`, `lib/ui`,
   `components/ui/icons`, `overlays/dialogs/frame.tsx`, and `store/repoRequests.ts`
   (`requestLease`). No new folders.

Stores: `repo` (wipe carry-list, `ReadOwner`, `requestLease`, action bodies). No new store.

## Risks / Trade-offs

- [A symbol is reached dynamically] → Decision 1 re-checks string dispatch. Run
  `bun run test`, `cargo test` and `bun run build` after each group.
- [Deleting the OAuth UI loses work someone intends to re-enable] → That is why it
  **Needs a decision**. Nothing is deleted until the maintainer picks.

## Findings

### A1-11 — `HeadLease` carries serde derives and a wire-format test, but never crosses IPC
- Priority: P3
- Smell: Speculative Generality / misleading Comment
- Where: src-tauri/src/git/write/reset.rs:76-90, 273-291; the actual wire type is src-tauri/src/git/types/requests.rs:104-117 (flat `expected_state`/`expected_head_branch`/`expected_head_oid`)
- Evidence: The doc says "The three fields travel as sibling keys on the wire (`ResetPreview`); the renames keep those exact camelCase names". A grep finds `HeadLease` only in reset.rs, and `ResetToRequest` is built with flat fields and reaches `ResetRequest::parse` as six loose arguments.
- Consequence: A reader assumes that changing `HeadLease` changes the IPC contract when it doesn't. The test pins a format nothing produces.
- Fix: Remove the `Serialize`/`Deserialize` derives, the renames, and the test. Alternatively make it real: `#[serde(flatten)] lease: Option<HeadLease>` in `ResetToRequest`, with `ResetRequest::parse(&ResetToRequest)` (Introduce Parameter Object).
- Confidence: high

### A1-12 — `commands/github.rs` keeps a second, hand-rolled thread-placement test that the registry test already covers
- Priority: P3
- Smell: Duplicate Code / Dead Code
- Where: src-tauri/src/commands/github.rs:277-333 vs src-tauri/src/commands/registration_tests/thread_placement.rs:22-73
- Evidence: A second `SYNC_BY_DESIGN = ["cancel_github_sign_in"]` list, its own line parser, and a magic `checked >= 18`. `thread_placement.rs` already scans every command file, including github.rs, against the closed global list.
- Consequence: Two allow-lists to update for one decision. The local one can drift (it has no stale-entry check), and `>= 18` breaks if PR commands are consolidated.
- Fix: Remove the `blocking_tests` module.
- Confidence: high

### A1-13 — Discard-all cleanup has a one-variant enum and a flag that is always false
- Priority: P3
- Smell: Speculative Generality / Dead Code
- Where: src-tauri/src/git/write/discard_all.rs:79-82, 283, 292; discard_all/cleanup.rs:23, 95-99, 137-147; discard_all/snapshot.rs:64, 98, 163-165
- Evidence: `enum CleanupKind { Ordinary }` is filtered with `leaf.kind == CleanupKind::Ordinary` (always true) and hashed through a one-arm `match kind { Ordinary => 0 }`. `cleanup_paths(…, include_ignored: bool)` has one caller, which passes `false`, so the `clean -f -x` branch is unreachable.
- Consequence: Readers look for a second cleanup class and an ignored-file path that don't exist. That is extra surface in the most destructive write.
- Fix: Inline Class / Remove Parameter. Delete `CleanupKind`, the `kind` field, the filter, and `include_ignored`, and hash a constant byte if token stability matters. The token is ephemeral between preview and execute, so it doesn't.
- Confidence: high

### A1-17 — Unused Windows-only imports in `discard_file`
- Priority: P3
- Smell: Dead Code
- Where: src-tauri/src/git/write/discard_file/discard.rs:5-6, src-tauri/src/git/write/discard_file/hooks.rs:3-4
- Evidence: `#[cfg(windows)] use std::os::windows::ffi::OsStrExt;` appears in both files. Grep finds no `encode_wide` or other `OsStrExt` use in `discard_file/`. The one legitimate copy is `state_lease.rs:22-23`, which uses it at line 123.
- Consequence: Windows builds emit `unused_imports`, and `cargo clippy -D warnings` would fail on a Windows leg.
- Fix: Remove the two imports.
- Confidence: high

### A2-16 — Stale or wrong comments in the slice
- Priority: P3
- Smell: misleading Comments
- Where / Evidence:
  - src-tauri/src/git/forge/gitlab/ops.rs:170-171: "GitLab's merge endpoint has no rebase-merge, so "rebase"/"merge" both do a plain merge", but :182-186 refuses "rebase".
  - src-tauri/src/git/forge/threads.rs:1: "(reply / resolve / unresolve)". Reply was removed (commit 3070e0fd, "remove in-app PR comment and review authoring").
  - src-tauri/src/auth_providers.rs:1-5: "…before real provider-specific PR integrations exist". GitLab, Bitbucket and Origin PR providers exist.
  - src-tauri/src/git/forge/service.rs:28: the key list omits `cursor-origin` (see #6).
  - src-tauri/src/git/forge/dto.rs:4: "visible only within the `github` module tree". The module is now `forge`.
- Consequence: readers get the wrong idea of behaviour and ownership.
- Fix: Rewrite the comments to match the code.
- Confidence: high

### A2-17 — Dead code and a no-op test
- Priority: P3
- Smell: Dead Code / Speculative Generality
- Where / Evidence:
  - src-tauri/src/git/forge/origin/capabilities.rs:58-63: `windows_message_is_origin_specific` asserts on a local string literal it declares itself, not on `ensure_supported` output. It cannot fail when the real message changes.
  - src-tauri/src/git/transport_auth.rs:179-181: the `System | Ssh => Ok(TransportCredential::None)` arm cannot be reached, because :95-97 already returned for those variants.
  - Duplicated constant, not dead: src-tauri/src/git/forge/bitbucket/transport.rs:39 `DIFF_RESPONSE_LIMIT = 32 * 1024 * 1024` (its Bitbucket-specific rationale at :35-38 can stay) repeats `bounded_output::DIFF_STDOUT_LIMIT` (limits.rs:5), which GitLab reuses at gitlab/transport.rs:28. The two diff ceilings can drift apart.
  - src-tauri/src/git/forge/gitlab/dto.rs:158-164 and src-tauri/src/git/forge/bitbucket/dto.rs:239-245: the `into_detail(…, commits: Vec<PrCommit>)` parameter is only ever passed `Vec::new()` (gitlab/ops.rs:58, bitbucket/ops.rs:60, and the tests). Those same two ops files also duplicate the files/additions/deletions derivation (gitlab/ops.rs:53-58, bitbucket/ops.rs:55-60).
- Consequence: a test that cannot fail, an unreachable branch, and duplicated constants and derivation to maintain.
- Fix: Remove the test (or assert on `ensure_supported()` under `cfg(windows)`). Delete the unreachable arm. Reuse `DIFF_STDOUT_LIMIT`. Remove Parameter `commits`, and Extract Method `detail_stats(&[FileDiff])`.
- Confidence: high

### A3-13 — `RemoteInfo.is_default` is documented as the "default push remote" but is the fetch/upstream remote
- Priority: P3
- Smell: Misleading name/Comment
- Where: git/types/repo.rs:107-109, git/read/remotes.rs:17-18,46 (uses `forge::default_remote_name`), git/read/branches.rs:131-146 (`configured_push_remote` implements git's real push precedence)
- Evidence: `default_remote_name` returns the current branch's upstream remote, else `origin`, else the first remote. It ignores `branch.<b>.pushRemote` and `remote.pushDefault`, which `branches.rs` honours for the same idea.
- Consequence: In a triangular setup (`remote.pushDefault=fork`), the Remotes panel badges `origin` as the push default while pushes go to `fork`.
- Fix: Rename Method/Field. Re-document `is_default` as "default (fetch/upstream) remote", or badge it from `configured_push_remote` if "push" is what the panel means.
- Confidence: medium

### A3-15 — Stale comments about "synchronous" commands and a dead lint allow
- Priority: P3
- Smell: Misleading Comments
- Where: lib.rs:55-62 ("The synchronous `working_changes` command … on the webview main thread"), git/status/working.rs:244-246 ("can't block this synchronous command"), git/status/working/new_path.rs:25-26 ("`file_diff` is a synchronous command"), git/status/history.rs:27 (`#[allow(clippy::too_many_arguments)]` on a 6-parameter fn, below clippy's threshold of 7)
- Evidence: `working_changes` and `file_diff` are `async` + `blocking` (commands/status.rs:16,21).
- Consequence: These comments justify design decisions (PATH warm-up, bounded rename probe) with a threading model that no longer exists, which misleads the next cost trade-off.
- Fix: Rewrite the comments in terms of blocking-pool latency and remove the dead `allow`.
- Confidence: high

### A3-19 — `build_profiled` / `GraphBuildMetrics` is a production API for a test-only consumer
- Priority: P3
- Smell: Speculative Generality
- Where: git/graph/layout/build.rs:15-35 (+ timing at 36, 51, 97-101, 145, 319-363), re-exports git/graph.rs:15-17, git/graph/layout.rs:7-9
- Evidence: The only caller is git/graph/tests/support.rs:72. The doc says it exists "for the repeatable release benchmark", but grep finds no benchmark in src-tauri, docs or scripts. Production `build` builds the metrics and discards them, and the struct needs `#[cfg_attr(not(test), allow(dead_code))]`.
- Consequence: Dead flexibility in the hottest read path. The allow attributes hide real dead code.
- Fix: Remove Parameter / Collapse Hierarchy. Make `build_profiled` and `GraphBuildMetrics` `#[cfg(test)]`, or delete them if the tests don't assert on timings.
- Confidence: medium (a benchmark may be planned)

### A3-21 — Small dead or duplicate items
- Priority: P3
- Smell: Middle Man / Duplicate Code / misleading Comment
- Where: terminal_agents/probe.rs:17-22 (`probe` only forwards to `probe_available`); git/credentials.rs:255-279 (`git_config_get_all` and `git_config_get_regexp` differ only in the flag); git/status/files.rs:22-26 (comment "The path *suggester* (`suggest_tree_paths`) still walks the whole worktree, so search is unaffected by this cap": it actually walks the HEAD tree with a 10 000-node budget, per git/read/paths.rs:9,36-48); git/types/worktree.rs:1-2 (module doc lists "the progress events the hand-off and delete flows stream", which now live in events.rs:92-108)
- Consequence: Misleading reading only. The files.rs comment in particular implies suggestions cover untracked and uncommitted files, and they don't.
- Fix: Inline Method (`probe`), Parameterize Method (`git_config_get(args)`), and correct the two comments.
- Confidence: high

### A4-8 — Dead code
- Priority: P3 (dead code)
- Smell: Dead Code / Speculative Generality
- Where / Evidence (each grep-checked across src, src-tauri/src, docs, scripts; tests excluded as callers):
  - `credential_helper_status` — TS wrapper `providersApi.credentialHelperStatus` (src/lib/api/providers.ts:122-127), `credentialHelperStatusSchema` (src/lib/api/schemas/providers.ts:47-50,90), `CredentialHelperStatus` interface (providers.ts:46-49), command src-tauri/src/commands/auth.rs:47 + src-tauri/src/lib.rs:249: no frontend caller. (`git::credentials::helper_status` itself is still used internally at credentials.rs:148,199 — keep it.)
  - `noreplyEmail` (src/lib/identities.ts:40-51): only referenced by its test. Its header (identities.ts:4-9) and doc say accounts "offer a one-click prefill … ('New identity from @login')", which CLAUDE.md explicitly says does not exist ("accounts do **not** prefill or otherwise feed identity cards").
  - `panelHeading` (src/lib/ui.ts:60): no importer.
  - `modKey` (src/lib/platform.ts:19): no importer; `modEnter` (platform.ts:22, one caller CommentEditor.tsx:42) duplicates `formatShortcut(ShortcutId.SubmitForm, isMac)` from the shortcut registry that claims to be the single declaration.
  - LeftPanel's Origin branch (src/features/pull-requests/LeftPanel.tsx:88-90, "Creating Cursor Origin pull requests isn't available in GitLane yet") is unreachable — `canCreatePullRequest(CursorOrigin)` is true via forgeHelp.ts:35 — and the comment at LeftPanel.tsx:50 ("Create is GitHub/GitLab/Bitbucket only") is stale. LeftPanel.tsx:131-133 rewrites any `prError` containing `"gh) not found"` into near-identical copy the backend already produces (domain.rs:141-143), i.e. text-parsing an error the contract says to branch on by `kind`/`code`.
  - `if (!parts) continue;` in scripts/check-file-sizes.mjs:78 — `countable` always returns an object.
- Consequence: code and a registered IPC command that nothing exercises; misleading docs on the identity model.
- Fix: Remove Dead Code — delete the listed symbols (all four layers for `credential_helper_status`), replace `modEnter` with `formatShortcut`, drop the LeftPanel dead branches.
- Confidence: high

### A4-10 — Stale or wrong comments at the IPC seam and in helpers
- Priority: P3 (misleading comments)
- Smell: Comments (stale)
- Where / Evidence:
  - src/lib/api/events.ts:162-171 re-declares `Equals`/`assertEqual` although src/lib/api/schemas/assertEqual.ts:7-8 says it is "the single definition so the helper is never copied"; events.ts:107-108,162-163 and src/lib/api/validate.ts:27-28 point at `schemas.ts`, which no longer exists (it is `schemas/`).
  - src/lib/api/schemas/github.ts:66 ("Lenient for the same reason as `mergeState` below") and src/lib/api/github/types.ts:103 ("See `mergeState`") reference a field that exists nowhere.
  - src/lib/mergeOutcome.ts:4-6 says the merge subprocess is pinned to `LC_ALL=C` in `src-tauri/src/git/write/branches.rs`; the pin is `LC_MESSAGES=C` with `LC_ALL` removed, in src-tauri/src/git/write/cli/command.rs:76-84.
  - src/lib/stashOutcome.ts:1 names a `stash_file` command; the command is `stash_paths`.
  - src/lib/api/git/commits.ts:25-26 "see write.rs::commit" (the module is `git/write/commits`).
  - src/lib/api/git/capturedIdentity.ts:2 says it is shared by the "commit/squash/squash-range" wrappers; those now take pre-built request objects, and only conflicts.ts plus two store modules call it.
  - scripts/check-import-cycles.mjs:3-4 "the tree already carries one cycle"; scripts/import-cycle-baseline.json is `[]`.
- Consequence: readers are sent to files/fields that do not exist and told the wrong locale contract.
- Fix: Rename/Remove comment — import `assertEqual` from `schemas/assertEqual` in events.ts and correct the listed references.
- Confidence: high

### A5-5 — Dead exports, props and re-exports in the slice
- Priority: P3
- Smell: Dead Code / Speculative Generality
- Where:
  - src/components/ui/InlineCode.tsx (whole file): no importers in src, tests, docs or scripts (only in stale `.claude/worktrees` copies).
  - src/components/ui/icons.tsx:247 `LaptopIcon` and :553 `CommentIcon`: no importers.
  - src/components/navigation/branch-navigator/rows/rowStyles.ts:3-5 `DIM_CLASS`, plus the `dimmed` prop on BranchRow.tsx:33/79, StashRow.tsx:17/33 and WorktreeRow.tsx:26/46. BranchNavigator never passes `dimmed`, and no other caller renders these rows. The comment admits the prop is "Kept for callers that want…".
  - src/components/navigation/branch-navigator/useNavigatorSections.ts:90/243 `NavigatorSections.head`: returned but never read by BranchNavigator or navItems (only a test fixture sets it).
  - src/features/terminal/TerminalAgentsSettings.tsx:17-19 `export { previewAvailability }`: the comment says it exists "so existing importers (and tests) keep a single import site", but nothing imports it from there. The test imports `./agentDraft`.
  - Test-only helpers: `addAgent`, `duplicateAgent` (terminal/agentDraft.ts:65,102); `addAiActionCommand`, `aiActionsValid` (ai-actions/aiActionDraft.ts:25,72). `trimAiActions` (:63) is used only inside its file but is exported.
  - src/features/agents/ai-actions/index.ts:2-13 re-exports `CUSTOM_ACTION`, `enabledAiActions`, `pickerActions`, `resolveAction`, `buildAiActionPrompt`, `scopeLabel`, `type AiActionScope`. External importers use only `AiActionsDialog`, `AiActionId`, `AiActionScopeKind`, `scopeFromSelection` and `scopeFromStackedReview`.
- Consequence: These are deletable code and props that readers must reason about. The `dimmed` / `DIM_CLASS` API implies that the navigator dims non-matches, but it actually filters them out.
- Fix: Remove Parameter / delete the listed symbols and the stale comments. Un-export `trimAiActions` and drop the unused barrel entries.
- Confidence: high

### A5-6 — Draft-list primitives are copied across the three settings editors
- Priority: P3
- Smell: Duplicate Code
- Where:
  - Splice-move: src/features/terminal/agentDraft.ts:114-120 `moveAgent`; src/features/agents/ai-actions/aiActionDraft.ts:42-52 `moveAiActionCommand`; src/features/agents/useAiAgentDraft.ts:249-256 (inline).
  - editingIds Set start/stop boilerplate: src/features/terminal/useCommitAgentMessagesDraft.ts:87-96; src/features/terminal/useTerminalAgentDraft.ts:113-123.
  - "name and command are required" predicate: `isAgentValid` (agentDraft.ts:38), `isAiAgentValid` (useAiAgentDraft.ts:44, identical body), and inline copies at AgentRowView.tsx:34, AgentRowEditor.tsx:36 and TerminalAgentsSettings.tsx:33.
  - Card shell with drag-lift style: AgentRow.tsx:43-58, AiAgentRow.tsx:86-104 and AiActionCommandRow.tsx:65-79 all use the same `{ opacity: 0.95, boxShadow: "0 18px 40px -12px …", position: "relative", zIndex: 20 }` plus the `border-[var(--accent)]/60` class ternary.
- Consequence: A behaviour fix to reordering or row validity (for example the bounds check in move) must be repeated in three named places.- Fix: Extract Function: one generic `moveItem<T>(list, from, to)` used by all three editors, and `isAgentValid` reused by the rows and the preview. Extract Function for the card-shell class/style, as a small `dragCardProps(dragging)` in `agentRowParts.tsx`, which both features already import.
- Confidence: high

### A5-8 — Inline SVGs duplicate the shared icon set
- Priority: P3
- Smell: Duplicate Code / Alternative Classes with Different Interfaces
- Where:
  - src/features/terminal/TerminalPanel.tsx:243-254 inlines the exact `ExpandIcon` path, while the same file imports `ExpandIcon` (line 27).
  - Warning triangle (path `M10.3 3.9 1.8 18…` + `M12 9v4M12 17h.01`): AgentRowEditor.tsx:145-148, AgentRowView.tsx:69-72, AiActionCommandRow.tsx:207-210, onboarding/icons.tsx:120-127 `WarningTriangle`. `WarningIcon` exists in icons.tsx:288.
  - Plus path `M12 5v14M5 12h14`: CommitAgentMessagesSettings.tsx:92-94, TerminalAgentsSettings.tsx:142-144, SupportedAgentsCard.tsx:279-288, terminalIcons.tsx:76-87 `PlusIcon`, onboarding/icons.tsx:149 `PlusGlyph`. `PlusIcon` exists in icons.tsx:427.
  - Search glyph: SupportedAgentsCard.tsx:65-75 (same as `SearchIcon`).
  - rows/RowGlyph.tsx:13-33: the cloud, tag and branch paths are identical to `RemotesIcon` (first path), `TagIcon` and `GitBranchIcon`. The check (line 8-10) is the same glyph as `CheckIcon`, redrawn.
  - terminalIcons.tsx: `CloseIcon` (same path as icons.tsx `CloseIcon`), `PlusIcon` (same path), `ClearIcon` (byte-identical to agentRowParts `DeleteGlyph`; the same glyph as `TrashIcon`, redrawn), `TerminalTabIcon` (the inner strokes of `TerminalIcon`). agentRowParts.tsx:114-138: `DuplicateGlyph` has the same path as `CopyIcon`. `EditGlyph`/`DeleteGlyph` are the same glyphs as `EditIcon`/`TrashIcon`, redrawn.
  - onboarding/icons.tsx: `ChevronRight` has the same path as `ChevronRightIcon`. `CheckGlyph`/`CheckSmall` are the same glyph as `CheckIcon`, redrawn, and `PlusGlyph` has the plus path above.
- Consequence: There are four icon sets with four prop shapes (`IconProps`, prop-less, `strokeWidth:number`). Restyling a glyph such as the warning triangle means editing 4-5 named places. terminalIcons.tsx justifies itself as "prop-less", which is not a reason, because the shared icons already take `className`/`width`.
- Fix: Inline Class: delete the local copies and use the `components/ui/icons` exports with `className` / `strokeWidth` overrides. Keep only genuinely distinct glyphs (e.g. `SpinnerRing`, `DragHandle`'s six dots).
- Confidence: high

### A5-9 — `LoadError` duplicates `ErrorFallback`
- Priority: P3
- Smell: Duplicate Code
- Where: src/components/ui/Loading.tsx:56-81; src/components/ui/ErrorFallback.tsx:9-46
- Evidence: ErrorFallback's doc says it is "Styled to match `LoadError`". The wrapper classes and button classes are verbatim copies. LoadError hand-inlines the focus-ring classes instead of `focusRing` and lacks ErrorFallback's `role="alert"`.
- Consequence: Two error surfaces must be restyled together. The PR tabs' load errors (PrChecksTab/PrDiffTab/PrCommitsTab/PullRequestDetail) are not announced to screen readers, while crash fallbacks are.
- Fix: Inline Class: `export const LoadError = (p) => <ErrorFallback retryLabel="Retry" {...p} />`, or migrate the callers and delete LoadError.
- Confidence: high

### A5-11 — Adding a navigator category touches many named places
- Priority: P3
- Smell: Shotgun Surgery / Switch Statements
- Where: src/components/navigation/branch-navigator/refs.ts:16-24 (`NavCategory`); CategorySidebar.tsx:22-29 (`CATEGORIES`); BranchNavigator.tsx:44-51 (`KIND_NOUNS`), 75-92 (the two parallel records `counts` and `visibleByCategory` over the same sections), 196 (`canCreate`); navItems.ts:120-126 (All groups) and 145-159 (per-category switch); useNavigatorSections.ts:77-95
- Evidence: Each category is spelled out once per table. `counts` and `visibleByCategory` differ only in `.total` vs `.items.length`.
- Consequence: A new ref kind (e.g. submodules, or splitting remotes per remote) needs coordinated edits in about eight places across four files. Missing one gives a runtime `undefined` count or noun, because the tables are `Record<NavCategory, …>` literals only in some files.
- Fix: Replace Conditional with a descriptor table: one `NAV_CATEGORIES` array in refs.ts carrying `{ key, label, Icon, nouns, section }`. Derive `counts`/`visibleByCategory`, the sidebar and `buildNavItems`' "All" groups from it.
- Confidence: medium (the design is deliberate today; the cost only appears when a category is added)

### A6-6 — Effects that only reset local state on a key change (the shape the React rules forbid)
- Priority: P3
- Smell: Temporary Field / rule violation (architecture-rules-react.md §1, "no useEffect whose body is only state writes")
- Where: src/features/changes/file-list/useFileFilter.ts:27-30, src/features/changes/changes-workspace/useWorkingTreeDiffs.ts:41-43, src/features/repo-files/FilesPanel.tsx:47-50, src/features/changes/commit-modal/useCommitExecutionController.ts:77-79, src/features/review/StackedReview.tsx:228-233
- Evidence: Each has the form `useEffect(() => { setX(reset) }, [key])`. The render-phase alternative already exists in the slice: `useAdvancedHistorySearch.ts:84-93` and `RepoFileWorkspace.tsx:43-49` ("Per-file view mode without an effect").
- Consequence: A render with stale state commits first. For example, `useFileFilter` filters the newly selected commit's files with the previous commit's query for one frame, and `amend` stays true for a render after `canAmend` goes false.
- Fix: Replace the effect with a keyed state record, as `RepoFileWorkspace` does, or with a `key` remount.
- Confidence: medium

### A6-7 — Stash-entry synthesis from a graph node is duplicated
- Priority: P3
- Smell: Duplicate Code
- Where: src/features/graph/historyRows.ts:206-214, src/features/changes/useInspectorCommit.ts:42-51
- Evidence: Both build `{ index, message, oid, timestamp, baseOid: parents[0] ?? null, baseTimestamp: null, context: [] }` from `commit.stash`.
- Consequence: A new `StashEntry` field has to be added in both places, or one surface drifts.
- Fix: Extract Function `stashEntryFromNode(node)` in `lib/` and use it at both sites.
- Confidence: high

### A6-8 — Two path-tree builders and two sets of tree rows that must stay pixel-identical by copying
- Priority: P3
- Smell: Duplicate Code
- Where: src/features/changes/commitTree.ts:36-97 (`buildRows`), src/features/repo-files/tree.ts:29-84 (`buildFileTree` and `flattenFileTree`); rows: src/features/changes/file-list/ChangedFileList.tsx:167-292 (`INDENT = 14`, `DirRow`, `TreeFileRow`, whose comments say "matches the repository Files tab"), src/features/repo-files/rows.tsx:5-73 (`INDENT = 14`, `DirRow`, `FileRow`)
- Evidence: Both group `/`-split paths into a `Map` tree, sort directories by default sort and files by `basename(...).localeCompare`, and collapse single-child directory chains. The row components share the indent, the 26px height, the chevron and folder icons, and the `+18` file offset, all by copy.
- Consequence: A tree ordering or indent change must be made twice, or the two trees stop lining up. The comments already rely on manual sync.
- Fix: Extract Function. One `lib/pathTree.ts` builder (with an optional roll-up of included files) plus shared presentational rows.
- Confidence: high

### A6-10 — History-inspect views re-implement the pieces already extracted beside them
- Priority: P3
- Smell: Duplicate Code
- Where: src/features/history-inspect/BlameView.tsx:51-70 (inline error state, the same as file-history/ErrorState.tsx:1-19), :134-176 (inline commit inspector with Copy SHA, subject, avatar and action buttons, the same as file-history/RevisionInspector.tsx and InspectorAction.tsx); src/features/history-inspect/DiffPane.tsx:57-73 (`TruncatedNotice`, the same as review/DiffBody.tsx:58-82 `DiffTruncatedNotice`)
- Evidence: Markup and classes are near-identical. `InspectorAction` was extracted, but BlameView still hand-rolls the same two action buttons.
- Consequence: Style or behaviour fixes land in one copy only.
- Fix: Extract Component. Reuse `ErrorState`, `InspectorAction`/`RevisionInspector` and `DiffTruncatedNotice` in BlameView and DiffPane.
- Confidence: high

### A6-12 — The Draft composer hand-rolls the shared agent status row, and the shared component's comment is stale
- Priority: P3
- Smell: Duplicate Code + misleading Comment
- Where: src/features/changes/commit-modal/CommitComposer.tsx:160-169, src/features/changes/AgentRunStatus.tsx:4-6; src/features/changes/commit-modal/DraftAgentControl.tsx:2-3,17
- Evidence: `AgentRunStatus` says it is "Shared by Draft / Describe, conflict resolve, and AI actions". Its only users are AiConflictResolve and AiActionsDialog. `CommitComposer` re-creates the same `role="status"` accent row, spinner and elapsed time, and adds a Stop button. `DraftAgentControl` documents "picks the terminal agent" and "enabled terminal agents (may include ones not on PATH)", but its prop is `AcpAgent[]` (in-app ACP agents only).
- Consequence: Styling of the status row drifts between surfaces, and readers are misled about which agent kind Draft uses.
- Fix: Extract Component. Give `AgentRunStatus` an optional `action` slot, use it in `CommitComposer`, and correct both comments.
- Confidence: high

### A6-13 — Dead code in the graph and changes features
- Priority: P3
- Smell: Dead Code / Middle Man
- Where: src/features/graph/palette.ts:21-22,31-35,46-51 (`GEOMETRY.branchWidth`, `GEOMETRY.graphWidth`, `laneX`, `gutterWidth`); src/features/graph/historyRows.ts:17,278 (`StashConnector.color`); src/features/graph/graphViewport.ts; src/features/changes/commitMeta.ts; src/features/review/comments/notes.ts:101 (`_branch` param); src/features/graph/commitAgents.ts:186-188 (`knownCommitAgent` wrapper)
- Evidence: I grepped src, src-tauri, scripts and docs. `laneX` and `gutterWidth` have no callers. `GEOMETRY.branchWidth`/`graphWidth` are read only by those dead functions; `ui/panels.ts` has its own `branchWidth`. `StashConnector.color` is written but never read, because `GraphLayer.tsx:214` strokes with `STASH_CONNECTOR`. `graphViewport.ts` is imported only by tests and named in docs/graph-performance.md:65. `commitMeta.ts` re-exports `initials` and only its own test imports it. `composeAgentMessage` ignores `_branch`, which ReviewNotes.tsx:49 still passes. `knownCommitAgent` just forwards to `knownAgent`.
- Consequence: Readers assume the graph has a branch column and an 8-lane gutter formula that nothing uses, and callers pass arguments that have no effect.
- Fix: Remove Dead Code / Remove Parameter / Inline Function. If the brute-force oracle is still wanted, move `graphViewport.ts` next to its test.
- Confidence: high

### A6-14 — Orphaned doc comments attached to the wrong declarations
- Priority: P3
- Smell: misleading Comments
- Where: src/features/review/comments/notes.ts:38-41 (describes a split-row `buildLineMeta` variant that no longer exists, then runs into `refIndex`'s own doc); src/features/conflicts/conflictModel/parse.ts:14-18 (the `parseConflict` doc sits above `splitFileLines`); src/features/conflicts/conflictModel/types.ts:31-32 (two stacked docblocks on `RegionDecision`)
- Evidence: TypeScript attaches the nearest JSDoc, so hover text is wrong. For example, `splitFileLines` shows "Parse conflicted file content into context + conflict regions…".
- Consequence: Editor tooltips and readers get the wrong contract.
- Fix: Remove Dead Code (comment). Delete the orphan and move the `parseConflict` doc to `parseConflict`.
- Confidence: high

### A7-9 — Carry-across-a-wipe field list spelled out five times
- Priority: P3 (duplication)
- Smell: Data Clump / Shotgun Surgery
- Where: src/store/repoLifecycle/publishSwitch.ts:155-160; src/store/repoMissing.ts:101-107; src/store/repoMissing.ts:252-258; src/store/repoTab/closeRepo.ts:79-92; src/store/repoTab/closeRepo.ts:113-121; contract src/store/repoTypes/data.ts:233-243
- Evidence: each wipe site spreads `repoDataWipe(...)` then re-reads `fetchingPath, netOps, sessionRestorePhase, initMissingRepoRunning` (+ `fileSelectionRequestId`, + `recents` in closeRepo) from `get()`. `repoDataWipe`'s doc says "a carry site must re-set from the current state"; the wipe is test-enforced, the carry list is not.
- Consequence: a new carried field (e.g. another transport flag) must be added in five places; forgetting one silently resets it on that path only.
- Fix: Introduce Parameter Object — `repoDataWipe(openPaths, carryFrom: RepoState)` (or `carriedRepoData(get())`) returning the carried fields.
- Confidence: high

### A7-10 — `ReadOwner` declared four times
- Priority: P3 (duplication)
- Smell: Duplicate Code / Data Clump
- Where: src/store/repoGuards.ts:9 (`RepoReadOwner`, exported); src/store/repoLifecycle/publishSwitch.ts:31 (exported `ReadOwner`); src/store/repoRefresh/publish.ts:37; src/store/repoRefresh/worktreeScope.ts:21
- Evidence: identical `{ path; session; generation }` shape; all four feed `readRequestIsCurrent`, which takes `RepoReadOwner`. The `{ path, session, generation: lane.claim() }` literal is also rebuilt at publishSwitch.ts:122-136, repoRefreshActions.ts:83-96, repoRemoteActions.ts:42-46, repoRefresh/history.ts:41-45.
- Consequence: owner shape changes need four type edits plus seven literal sites.
- Fix: Inline the local copies to `RepoReadOwner`; optionally Extract Function `claimReadOwner(lane, path, session)`.
- Confidence: high

### A7-11 — GL-351's `requestLease` adoption is incomplete; the idiom is still hand-rolled
- Priority: P3 (duplication)
- Smell: Duplicate Code (misleading comment)
- Where: claim src/store/requestLease.ts:4-9; hand-rolled: src/store/repoFilesActions.ts:61-65 (five counters), src/store/repoSelectionDiff.ts:12, src/store/accounts.ts:124, src/store/accounts/ghAccounts.ts:65, src/store/accounts/forgeAuth.ts:36, src/store/identities/writeQueue.ts:23, src/store/repoSelection/generations.ts:27-80 (claim/current/invalidate per lane = `RequestLease`'s API five times)
- Evidence: requestLease.ts says the "module-level counter + begin… + …IsCurrent" copies were replaced by a named lease; nine more lanes still do `let gen = 0; const g = ++gen; if (g !== gen) return`.
- Consequence: the "one idiom, one name" invariant the header asserts is false; reviewers have to re-verify each hand-rolled counter.
- Fix: Substitute Algorithm — replace each counter with `requestLease()` (`invalidate` = `claim()`); make generations.ts return `{ list: requestLease(), diff: requestLease(), blame: requestLease() }`.
- Confidence: high

### A7-15 — Stale comments describing behaviour the code no longer has
- Priority: P3 (misleading comments)
- Smell: Comments (stale)
- Where: src/store/ui/updatePrefs.ts:22-23,42 vs src/store/updates.ts:108-116; src/store/repoLifecycleActions.ts:227-231 vs src/store/identities/storage.ts:19-20,110-114 and src/store/identities.ts:74-81; src/store/accounts/forgeAuth.ts:29-32; src/store/pullsQueue.ts:4-6; src/store/accounts/transportAuth.ts:43-57
- Evidence: (a) updatePrefs says `lastUpdateCheckAt` is "the last attempt" and `markUpdateChecked` is "called … on any check"; updates.ts deliberately stamps only when up to date. (b) `locateMissingRepo` says it carries "the applied profile + custom-email overrides"; custom-email keys are deleted by the GL-130 migration and `migrateIdentityBindings` moves only the applied map. (c) forgeAuth.ts:29-32 describes a whoami provider list "listed here" that moved to `lib/forgeHelp` (`FORGE_WHOAMI_PROVIDERS`); the comment now sits on `forgeAuthGen`. (d) pullsQueue.ts says `currentPrListRequestKey`/`prListLoadOwnsSlot` "stay in pulls.ts"; they live in pullsResource.ts and pulls/list.ts. (e) `gitlabRemoteHosts`/`bitbucketRemoteHosts` claim to be the one shared place for host resolution; they are one-line wrappers over `remoteHostsFor`.
- Consequence: readers act on wrong invariants (e.g. assume a failed check throttles for a day).
- Fix: Rewrite/delete the comments; Inline Function for the three `*RemoteHosts` wrappers.
- Confidence: high

### A7-16 — Near-identical action bodies in the write/selection slices
- Priority: P3 (duplication)
- Smell: Duplicate Code
- Where: src/store/repoWriteActions/history.ts:153-177 vs 179-203 (`cherryPickMany`/`revertMany`), plus the `ownerIsCurrent && commitSetIsCurrent → clearSelection` tail at 173-175, 199-201, 266-268; src/store/repoWriteActions/staging.ts:129-142 vs 167-178 (`applyHunk`/`applyLine` reselect block); src/store/repoSelection/commits.ts:279-330 vs 332-372 (`selectFile`/`loadFullFileDiff`, same `fresh()` guard, route and fetch)
- Evidence: each pair differs only in the API call / message verb (or the `full` flag and whether `selectedFile` is set).
- Consequence: guard fixes must be applied twice (the ownership guards here were each patched in several reviews).
- Fix: Extract Method — `runBatchPick(shas, call, verb)`, `reselectAfterPatch(path, staged, owner, fileSelection)`, and `fetchSelectedFileDiff({full})` shared by selectFile/loadFullFileDiff.
- Confidence: high

### A8-8 — Unreachable native-OAuth UI chain kept alive after the provider-auth simplification
- Priority: P3 (dead code)
- Smell: Dead Code / Speculative Generality
- Where: src/components/chrome/settings/accounts-panel/provider-connect/OauthMethod.tsx (whole file), src/components/chrome/settings/accounts-panel/provider-connect/oauth.ts:11,83-113 (`OAUTH_PROVIDERS`, `isOauthProvider`, `useOauthConfigured`; `OAUTH_HELP` used only by OauthMethod), src/components/chrome/settings/accounts-panel/provider-connect/ui.tsx:20-36,83-90 (`StateBlock`, `ShieldIcon`), src/components/chrome/overlays/provider-oauth/* (reachable only via `openProviderOauthSignin`), src/components/chrome/SettingsModal.tsx:59-63
- Evidence: `grep -rlw OauthMethod src` → only its own file; the render site was removed in dfac0d13 ("Simplify provider auth and remote checkout"). The sole caller of `openProviderOauthSignin` is OauthMethod.tsx:115, so ProviderOauthDialog, useProviderOauthRun, provider-oauth/steps and the SettingsModal suspension clause for it can never activate. `OAUTH_PROVIDERS`, `isOauthProvider`, `useOauthConfigured`, `StateBlock`, `ShieldIcon` have zero references anywhere (src, docs, scripts). ForgeConnect.tsx:1-4 says these flows are "not offered while this auth model is being simplified" — a parking decision, but no open OpenSpec change tracks it, the render site has been gone since 2026-07-08 while the archived `2026-09-15-harden-provider-oauth-sign-in` kept investing in the flow, and docs/provider-oauth-setup.md plus CLAUDE.md (GL-139 section) still describe an in-app OAuth sign-in button users can press.
- Consequence: ~900 lines of chrome UI must be kept compiling and reviewed for a flow no user can start, and the docs promise a feature the UI no longer exposes.
- Fix: Remove Dead Code (delete the files and the ui.tsx/oauth.ts exports) or, if parked deliberately, record it as a GL ticket and delete the zero-reference helpers now.
- Confidence: high (unreachable); medium on whether to delete vs track

### A8-9 — Smaller dead code / middle men in the settings and menu modules
- Priority: P3 (dead code)
- Smell: Dead Code / Middle Man
- Where: src/components/chrome/settings/identity.ts:1-21; src/components/chrome/settings/accounts-panel/providers.ts:45-56 (`ConnectState`, `connectState`), 58-63 (`prSupportedFor`); src/components/chrome/settings/accounts-panel/provider-connect/credential-entry/CredentialEntryForm.tsx:20,33-34,46-53,61-88,161-171 (keychain destination); src/components/chrome/overlays/menus/file-context-menu/WorkingFileMenu.tsx:56,119; src/components/chrome/action-bar/actionBarModel.ts:50-58 (`isPrForge`, `canCreatePullRequest`)
- Evidence: `isIdentityValid`/`isIdentityDirty` (settings/identity.ts) are imported only by identity.test.ts. `connectState`/`ConnectState` have no reference outside providers.ts. Both `CredentialEntryForm` call sites pass `helperOnly` (ForgeConnect.tsx:45, GithubConnect.tsx:70), so `keychainAvailable` is always false and the helper/keychain segmented toggle, `saveProviderToken` branch and "Store in keychain" copy never render. `const showIgnore = true; if (showIgnore) …` is a constant guard. `isPrForge`/`canCreatePullRequest`/`prSupportedFor` only forward to `supportsPullRequests`/`supportsCreatingPullRequests` (and features/pull-requests/LeftPanel.tsx and features/changes/commit-modal/commitComposerModel.ts import `canCreatePullRequest` from components/chrome/action-bar to get it).
- Consequence: Tests pin behaviour nothing uses; readers must reason about branches that cannot execute.
- Fix: Remove Dead Code (delete settings/identity.ts + its test, `connectState`, the keychain branch and the `helperOnly` prop, the constant guard); Remove Middle Man (call the `forgeHelp` predicates directly).
- Confidence: high

### A8-10 — Remove-worktree plumbing carries fields nothing reads
- Priority: P3 (dead code / misleading API)
- Smell: Dead Code / Speculative Generality
- Where: src/components/chrome/overlays/menus/useRemoveWorktree.ts:12-14,60-68; src/components/chrome/overlays/menus/removeWorktreeConfirm.ts:24-26,123; callers src/components/chrome/overlays/menus/WorktreeContextMenu.tsx:135-141, src/components/chrome/overlays/menus/branch-context-menu/worktreeActions.tsx:71
- Evidence: `RemoveWorktreeRequest` requires `branch` and accepts `head`/`locked`, and both callers compute them, but `useRemoveWorktree` builds the confirm from `preview.branch`, `preview.headOid`, `preview.locked` — only `request.name`/`request.path` are read. `RemoveWorktreeConfirm.force` (and the `requiresForce ?? (uncommitted || locked)` fallback) is consumed only by removeWorktreeConfirm.test.ts; the hook ignores it (execute derives force from the lease).
- Consequence: Callers believe their branch/lock snapshot matters; a future edit may "fix" the caller instead of the lease.
- Fix: Remove Parameter — narrow the request to `{ name, path }` and drop `force` from `RemoveWorktreeConfirm`.
- Confidence: high

### A8-12 — Five progress/sign-in dialogs copy the same chrome and skip the shared buttons (no focus ring)
- Priority: P3 (duplication / style-rule breach)
- Smell: Duplicate Code
- Where: badge tone ternaries — src/components/chrome/overlays/delete-worktree/DeleteWorktreeDialog.tsx:105-126, src/components/chrome/overlays/handoff/HandoffDialog.tsx:111-130, src/components/chrome/overlays/remove-detached/RemoveDetachedDialog.tsx:68-89, src/components/chrome/overlays/github-signin/GithubSigninDialog.tsx:88-101, src/components/chrome/overlays/provider-oauth/ProviderOauthDialog.tsx:53-66; done-focus effect — DeleteWorktreeDialog.tsx:94-97, HandoffDialog.tsx:97-100, RemoveDetachedDialog.tsx:59-62; `displayUrl` — GithubSigninDialog.tsx:359-361, ProviderOauthDialog.tsx:254-256; device-flow labels — src/components/chrome/overlays/github-signin/steps.ts:27-38 vs src/components/chrome/overlays/provider-oauth/steps.ts:50-61; footer buttons — the literal `h-10 flex-1 rounded-xl …` Cancel/Close/primary class strings in all five files
- Evidence: Each dialog re-spells the emerald/rose/neutral 40px badge and the 2-button footer class strings instead of `DialogPrimaryButton`/`DialogCancelButton` (frame.tsx:195-247); those hand-spelled buttons carry no `focusRing`, contrary to architecture-rules-react.md §2 ("Every interactive element needs … a focus ring").
- Consequence: A visual/a11y fix has to be made five times; keyboard users get no focus indication on these dialogs' main buttons.
- Fix: Extract Component — `OutcomeBadge({ phase, idleIcon })` and a large-variant of the frame buttons in overlays/dialogs/frame.tsx; move `displayUrl` and the shared device-flow label function into overlays/progress.
- Confidence: high

### A8-14 — `WindowControls` and `WindowResizeHandles` duplicate the Tauri window guard and maximized tracking
- Priority: P3 (duplication)
- Smell: Duplicate Code
- Where: src/components/chrome/WindowControls.tsx:8-35, src/components/chrome/WindowResizeHandles.tsx:19-25,64-77
- Evidence: Byte-identical `win()` try/catch helper and identical `isMaximized` + `onResized` subscribe/unlisten effect in both components, both mounted off-mac, so two resize listeners track the same flag.
- Consequence: A fix to the guard or unlisten race must be applied twice.
- Fix: Extract Function/Hook — `useWindowMaximized()` + `currentWindow()` in one module used by both.
- Confidence: high

### A8-15 — `ActionBarModel.openRepoSettings` is typed without the section it actually forwards
- Priority: P3 (API will be misused)
- Smell: Primitive Obsession / misleading signature
- Where: src/components/chrome/action-bar/useActionBarModel.ts:69,93,295; src/components/chrome/action-bar/ActionBar.tsx:163; src/components/chrome/action-bar/provider-indicator/ProviderIndicator.tsx:104,133
- Evidence: The interface declares `openRepoSettings: () => void`, but it is the store's `(section?: RepoSettingsSection) => void` and ProviderIndicator calls it with `"identity"`/`"remotes"`. It works only because TS lets a 0-arity type stand in for a 1-arity function; wrapping it per the declared type (`() => openRepoSettings()`) would silently lose the deep-link section.
- Consequence: The "Manage remotes…" deep link depends on an undeclared argument.
- Fix: Change the interface to `openRepoSettings: (section?: RepoSettingsSection) => void`.
- Confidence: high

### A8-17 — Stale lint allowlist / comment for `api` importers in menus
- Priority: P3 (stale config / comment)
- Smell: Comments (stale)
- Where: eslint.config.js:241,246; src/components/chrome/overlays/menus/index.ts:5-11
- Evidence: The `api` allowlist still exempts `menus/CommitContextMenu.tsx` and `menus/useRemoveWorktree.ts`, neither of which imports `api` any more (useRemoveWorktree goes through `useRepo.previewRemoveWorktree`). The menus barrel comment lists "ActionMenu, BranchContextMenu (preview reads), CommitContextMenu, useBranchFastForwardProbe, useDiscardAllChanges", but the actual importers are ActionMenu, branch-context-menu/destructiveActions, forcePushConfirm, resetSubmenu, useBranchFastForwardProbe, useDiscardAllChanges.
- Consequence: The boundary exemption is wider than needed, so a direct `api` import added to those two files would pass lint silently.
- Fix: Remove the two stale allowlist entries and refresh the comment.
- Confidence: high

### A8-18 — About panel says "Visual git client for macOS"
- Priority: P3 (stale copy)
- Smell: Comments/copy (stale)
- Where: src/components/chrome/settings/AboutPanel.tsx:85
- Evidence: Hard-coded subtitle, while the same panel computes `platformLabel` for Windows/Linux (line 25) and the app ships for all three (CLAUDE.md).
- Consequence: Windows/Linux users read a wrong product description.
- Fix: Replace with "Visual git client" (or interpolate `platformLabel`).
- Confidence: high

### A8-19 — Repo-slug / folder-leaf helpers re-implemented beside existing ones
- Priority: P3 (duplication)
- Smell: Duplicate Code
- Where: src/components/chrome/repo-settings/RepoSettingsModal.tsx:27-33 (`repoSlug`), src/components/chrome/action-bar/provider-indicator/model.ts:36-39 (`slugOf`), src/components/chrome/repo-settings/remotes-panel/RemotesPanel.tsx:13-14 (`repoLeaf`), src/lib/paths.ts:16-18 (`repoLabel`)
- Evidence: `repoSlug` and `slugOf` both do `webUrl.replace(/^https?:\/\/[^/]+\/?/, "").replace(/\.git$/, "")` with a host/leaf fallback; `repoLeaf` and `repoSlug`'s fallback re-derive the workdir leaf that `repoLabel` (already used by IdentityChip.tsx:152 and ProjectTab.tsx:43) computes — the copies also differ on fallback text ("this repository" vs "Repository") and on handling `\\` separators.
- Consequence: Three spellings of the same repo name can render differently in the toolbar popover, the Repository settings rail and the Remotes header.
- Fix: Extract Function — move `slugOf` into lib/paths (or lib/forgeUrls) and use it plus `repoLabel` at all sites.
- Confidence: high
