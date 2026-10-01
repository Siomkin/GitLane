# Design

## Context

See proposal.md (Why). The per-finding evidence is under **Findings**. Engines do not
change: PR actions stay on each provider's boundary, resets and operations stay on the git
CLI, and reads stay on libgit2.

## Goals / Non-Goals

**Goals:** parse each closed set once at the boundary, keep error kinds typed from where
they are observed to IPC, and stop control flow from depending on message text.

**Non-Goals:** codegen, message rewording, and new error kinds beyond `fileMissing` and the
per-remote fetch detail.

## Decisions

1. **Enums live in `git/types/`.** `MergeMethod` and `PrStateAction` go in
   `git/types/forge.rs`. `OperationKind` (`git/types/conflicts.rs`) gains `Deserialize` and
   `fn subcommand(self) -> Option<&'static str>`. `ResetToRequest.mode` deserializes
   straight into `ResetMode`. Each provider matches exhaustively, so a new variant becomes
   a compile error at every provider. Alternative: validate the strings in one helper.
   Rejected, because it keeps six parallel `match` tables.
2. **git2 errors.** Delete the stringifying `map_err`s, since `blocking` already accepts
   `E: Into<CommandError>`. Change `(ErrorClass::Os, _) => MissingPath` to `Internal`, and
   update the pinned test. `repoMissing.ts::wentMissing` already re-probes on non-missing
   kinds, so a deleted folder is still detected (see the spec scenario).
3. **Stale leases.** Add one `pub(crate) fn stale(msg: &str) -> String` in
   `write/classify.rs` that appends the canonical suffix, and match on the suffix. Every
   lease site listed in A1-2 calls it. A unit test greps `src/git/write/**/*.rs` for
   `again.` literals that don't go through `stale(`.
4. **Substring control flow.** `transport_auth::credential_for_remote` returns
   `Ok(None)` for a remote with no URL. `worktree_removal_lease::capture` returns
   `enum Capture { Stale(String), Other(String) }`. Fetch errors carry
   `detail: [{ remote, code }]` on `CommandError`, and `gitError.ts` drops
   `transportCodeOf` and its five regexes. `repo_file_text` sets `code: "fileMissing"`.
5. **CaptureError.** Add a `GithubError::Capture(CaptureError)` variant that the three CLI
   finishers return instead of a string, so `forge::ipc` applies the existing
   `From<CaptureError> for CommandError` and `outputTooLarge`/`captureFailed` reach the UI.
6. **TS mirrors.** `GitTransportAuthRef` becomes a discriminated union on `mode`.
   `ACTIVE_OPERATION_KINDS` is typed `satisfies readonly ActiveOperationKind[]`.

**IPC four layers** (per command): `merge_pull_request`, `set_pull_request_state`,
`reset_to` / `preview_reset`, `continue_operation` / `abort_operation` / `skip_operation`,
`fetch`, and `repo_file_text`. Each changes impl, command, type and TS wrapper together.
The `registration_tests` enforce names and argument sets. Stores: `repo` (operation status
and file text). No new store.

## Risks / Trade-offs

- [The Os → internal remap misses a "path gone" case that only surfaced as Os] → The
  frontend re-probe is authoritative. Add a test that deletes the repo folder mid-session
  and asserts the missing state.
- [Enum deserialization changes the error text for bad input] → Only malformed callers
  are affected. The shipped frontend already sends the typed unions.
- [The fetch `detail` shape is new IPC surface] → It is additive and optional. The zod
  schema treats it as optional.

## Findings

### A1-2 — `STALE_LEASE_MARKERS` misses most lease wordings, so destructive-lease failures get `kind: git`, not `staleLease`
- Priority: P2
- Smell: Primitive Obsession (a category derived from free text) + misleading Comment
- Where: src-tauri/src/git/write/classify.rs:71-77, 165-170. Wordings that don't match: discard_all.rs:77, discard_all/nested.rs:49 and discard_all.rs:306 (lower-case "refresh and preview again." fails the case-sensitive `contains`), hard_reset_lease/scope.rs:15, worktree_removal_lease.rs:27, remotes/force_push.rs:71,77,82,88, reset.rs:124,131, operands.rs:35, branches/delete.rs:20, patch_staging/extract.rs:63,71,86,133,143,203
- Evidence: The doc says it is the "Stale-lease wording every leased write in this crate ends with (see `head.rs`, `identity.rs`, `discard_all.rs`, `reset.rs`)". But `discard_all.rs` ends with "Preview Discard all again.", `reset.rs` with "Preview again.", the hard reset with "Preview the hard reset again.", worktree removal with "Preview the removal again.", force-push with "Preview the force-push again.", and hunk staging with "refresh the diff and try again". None of these match "Refresh and try again." / "Refresh and preview again." / "changed before this operation".
- Consequence: Every exact-state lease except head/identity crosses IPC as `kind: git`. Today only `src/store/repoConflictActions.ts:16` branches on `staleLease`, and the identity wording it relies on does match. Any new frontend handling (for example "re-open the preview on staleLease") will silently skip discard-all, hard reset, worktree removal, and force-push, and every new message has to guess the magic suffix.
- Fix: Replace Magic Literal with a constant. Put one `STALE_SUFFIX` (or a `stale(msg)` helper) in `classify.rs`, make every lease message end with it, and add a test that greps `write/` for "again." messages the classifier would miss.
- Confidence: high

### A1-3 — The reset preview silently degrades an unknown mode to "mixed"; the write path rejects it as unsafe
- Priority: P2
- Smell: Alternative Classes with Different Interfaces (two parsers of one input disagree)
- Where: src-tauri/src/git/write/recovery/reset.rs:23-26, 125-169 vs src-tauri/src/git/write/reset.rs:13-16, 28-37
- Evidence: The preview does `let mode = match mode { "soft" | "mixed" | "hard" => mode, _ => "mixed" };`. `ResetMode::parse`'s doc says "degrading it to `mixed` would run a weaker reset than the one the UI confirmed — and one that skips the hard-reset lease entirely."
- Consequence: A misspelled or new mode (for example "Hard" or "keep") previews as "Reset mixed to …" with no lease, and the write then fails with "Unknown reset mode". The confirm describes an operation that can never run. The two string tables must also be kept in sync by hand.
- Fix: Replace Type Code with Class. Call `ResetMode::parse(mode)?` in `preview_reset` and match on the enum. Ideally `ResetToRequest.mode` (git/types/requests.rs:110) deserializes straight into `ResetMode`.
- Confidence: high

### A1-4 — `fetch` decides "skip this remote" by substring-matching another module's error text
- Priority: P2
- Smell: Primitive Obsession / Inappropriate Intimacy (control flow on a message string)
- Where: src-tauri/src/commands/remotes.rs:186; the message comes from src-tauri/src/git/transport_auth.rs:64-66. Same pattern in src-tauri/src/git/write/worktree_removal_lease.rs:334-345 (`error.contains("missing") || … "registration" || "gitdir"`) and src-tauri/src/git/write/worktrees/lifecycle.rs:311-312 (`branch_message == format!("Deleted {branch}")`)
- Evidence: `Err(err) if err.contains("was not found or has no URL configured") => {}`. `validate_removal_lease` also treats any capture error containing the word "missing" as stale, which includes unrelated git/IO errors that happen to use that word.
- Consequence: Rewording `transport_auth.rs:65` makes Fetch fail for every bound remote that has no URL, and nothing fails at compile time. The lease prefix and the delete-message comparison break the same way when their copy is edited.
- Fix: Replace Error Code with Exception / Introduce Parameter Object. Have `credential_for_remote` return `Ok(None)`, or a typed `RemoteMissing` variant, for a URL-less remote. Have `capture` return a small enum (`Stale(String)` / `Other(String)`). Have `deleted_branch_message` return `Result<(), String>` for the cleanup half.
- Confidence: high

### A1-8 — `git2::Error`s are stringified at the command boundary, discarding the typed `notARepository` / `missingPath` kinds
- Priority: P3
- Smell: Middle Man / misleading Comment
- Where: src-tauri/src/commands/conflicts.rs:9,17; files.rs:13,26,40; identity.rs:40; repo.rs:39,63,74; every fn in status.rs (17-161) vs `mod.rs:43-45` ("`git2::Error`s are typed") and git/types/error.rs:150-161
- Evidence: For example `blocking(move || git::status::working_changes(&path).map_err(|e| e.to_string()))`, where the impl returns `git2::Error`. `From<git2::Error>` maps `(Repository, NotFound)` to `NotARepository` and `Os` to `MissingPath`. `.to_string()` instead routes the error through `classify_failure`'s CLI regexes, which yields `kind: git`. In the same file, repo.rs:47,58,85 pass the error through untouched.
- Consequence: A repo that disappears mid-session reports `kind: git` from every read except `open_repo`, so `src/store/repoMissing.ts:58-69` needs an extra `open_repo` IPC probe on every failure to recover the kind. The `.map_err` calls are deletable code that loses information.
- Fix: Remove Middle Man. Drop `.map_err(|e| e.to_string())`, because `blocking` already accepts `E: Into<CommandError>`.
- Confidence: high

### A1-10 — Operation kinds are strings in three `match` tables, although `OperationKind` exists
- Priority: P3
- Smell: Primitive Obsession / Switch Statements
- Where: src-tauri/src/git/write/conflict_resolution.rs:211-222, 240-249, 303-307; src-tauri/src/commands/conflicts.rs:53,71,78 (`kind: String`); src-tauri/src/git/types/conflicts.rs:9-18 (`OperationKind`, `Serialize` only); src-tauri/src/git/write/branch_checkout.rs:87-92 (round-trips the enum through `serde_json` to get the wire word back)
- Evidence: `"merge" => &["merge","--continue"], "rebase" => …, "cherry-pick" => …, "revert" => …` is repeated for continue, abort, and skip, plus `kind == handoff::CARRY_KIND` checks.
- Consequence: A new drivable operation needs edits in the enum, the reader, three string tables, and the carry special case. A typo in the frontend's kind string gets a runtime "no active operation" error instead of a deserialize failure.
- Fix: Replace Type Code with Class. Derive `Deserialize` on `OperationKind`, take it at the command boundary, and give it `fn subcommand(self) -> Option<&'static str>` so the three tables collapse to `[sub, "--continue"]` etc.
- Confidence: high

### A2-5 — Merge method and PR state action are raw strings, parsed separately per provider with conflicting fallbacks; gh closes the PR on an unknown action
- Priority: P1
- Smell: Primitive Obsession / Switch Statements (the same type code matched in 6 places with different defaults)
- Where: src-tauri/src/git/forge/prs/mutations.rs:42-48 (`_ => "close"`); src-tauri/src/git/forge/prs/merge.rs:132-136 (`_ => "--merge"`); src-tauri/src/git/forge/prs/stacks.rs:225-231; src-tauri/src/git/forge/gitlab/ops.rs:182-194 (anything except "rebase"/"squash" → plain merge); src-tauri/src/git/forge/bitbucket/ops.rs:267-278 (unknown → error); src-tauri/src/git/forge/origin/ops.rs:107-114 (unknown action → error) and :131-140 (unknown method → `--merge`); trait signature at src-tauri/src/git/forge/service.rs:70-76, :157-164; IPC takes `method: String` / `action: String` at src-tauri/src/commands/github.rs:189, :207, :231
- Evidence: `set_pr_state_args(repo, num, "bogus")` produces `gh pr close`, and the test pins this as "historical behaviour" (mutations.rs:180-184). Origin rejects the same input. For merge methods, Bitbucket errors on an unknown value while gh, GitLab and Origin quietly do a merge commit. The frontend already types these as unions (`MergeMethod`), so the backend throws the type away and re-parses the string six times.
- Consequence: a typo or a new action value from any caller closes a GitHub PR, an irreversible and visible write. The same input gives different results per forge. Adding a method or action touches 6 match sites in 5 files.
- Fix: Replace Type Code with Class. Add `enum MergeMethod { Merge, Squash, Rebase }` and `enum PrStateAction { Close, Reopen, Ready }` (serde, in git/types/forge.rs), deserialize them at the command boundary, and have each provider match exhaustively.
- Confidence: high

### A2-9 — Typed capture errors become strings and are re-classified by substring; `From<CaptureError> for CommandError` is dead
- Priority: P2
- Smell: Dead Code / Primitive Obsession
- Where: src-tauri/src/git/forge/bounded_output/error.rs:32-42; src-tauri/src/git/forge/cli/command.rs:139-152; src-tauri/src/git/forge/gitlab/transport.rs:138-149; src-tauri/src/git/forge/origin/command.rs:66-80; src-tauri/src/git/forge/domain.rs:99-104; docs/rules/architecture-rules-rust.md:187-188; src-tauri/src/git/types/error.rs:10
- Evidence: all three CLI sites turn `CaptureError` into `String` (e.g. `format!("gh {other}")`). `from_command` then sniffs the text again (`"gh) not found"` → `ProviderUnavailable`). Nothing converts `CaptureError` into `CommandError`: the only references are the definition, the three stringifiers and tests. So the `outputTooLarge` / `captureFailed` codes that the impl and the rules doc promise never reach the UI. A 32 MiB+ PR diff comes back as `commandFailed` with text "gh stdout exceeded the … output limit".
- Consequence: the code and docs promise a typed "too large" error the UI can never receive. The gh-missing path depends on the exact wording of a message built three files away.
- Fix: Replace Error Code with Exception (typed). Carry `CaptureError` (or a `GithubError::Capture(CaptureError)` variant) up to `forge::ipc` so the existing `From` impl applies. Otherwise delete the impl and fix the doc lines.
- Confidence: high

### A3-2 — Every libgit2 OS-class error is reported as "repository missing"
- Priority: P1
- Smell: Switch Statement on the wrong discriminant / misleading classification
- Where: git/types/error.rs:150-161 (`From<git2::Error>`: `(git2::ErrorClass::Os, _) => CommandErrorKind::MissingPath`), test that pins this mapping at git/types/error.rs:264-269; consumer `src/store/repoMissing.ts:40-43,59-70`
- Evidence: Any `GIT_ERROR_OS` becomes `missingPath`, not just a vanished repo. That includes EACCES on a worktree directory or index, EMFILE, and EIO on a flaky external volume. On the frontend, `wentMissing` treats a `missingPath` rejection as authoritative ("A `missingPath` / `notARepository` rejection is authoritative") and skips its `openRepo` re-probe. It then calls `enterMissingState`.
- Consequence: Suppose a refresh read (`working_changes` walking a `chmod 000` subdirectory, or any read hitting EMFILE) fails with an OS-class error. The tab swaps to "This repository can't be found… moved or deleted" and the workspace is cleared, even though the repo is still there. The only real missing-path case, a failed open, is already classified correctly by `RepoOpenError` (git/read/repo.rs:61-81).
- Fix: Replace the conditional. Map `ErrorClass::Os` to `Internal`, and let the existing `wentMissing` re-probe through `openRepo`/`summary_classified` decide whether the path is really gone. Update the pinned test at error.rs:264-269.
- Confidence: medium (depends on which libgit2 paths raise `GIT_ERROR_OS` for EACCES/EMFILE, but the mapping catches every one of them)

### A4-5 — Transport-failure classification re-done in TypeScript with copied (and already drifted) Rust regexes
- Priority: P2 (costly to change)
- Smell: Duplicate Code / Divergent Change
- Where: src/lib/gitError.ts:1-8,60-79,139-155,186-211; src-tauri/src/git/write/classify.rs:52-64; src-tauri/src/git/write/remotes/fetch.rs:51-52,108-113
- Evidence: `CREDENTIAL_PROMPT_DISABLED`, `SSH_AUTH_FAILURE`, `SSH_HOST_KEY_FAILURE`, `REMOTE_UNREACHABLE`, `REMOTE_NOT_FOUND_OR_DENIED` are verbatim copies of the classify.rs regexes, and they have already drifted (the TS `REMOTE_UNREACHABLE` has an extra `host key verification failed` alternative absent from classify.rs:60). Because fetch labels every remote's output unconditionally, success and failure alike (`label_remote_output` → `format!("{remote}:\n…")`, called per remote at fetch.rs:51-52), `friendlyTransportError` takes the per-block path for every fetch — even single-remote — and the TS regex's code replaces the backend's `code`. The header's claim "the regexes that remain are formatting, not classification" is not true for these five.
- Consequence: a new or changed git transport message must be taught to both classifiers; if only Rust is updated, fetch failures still show generic copy.
- Fix: Move Method — have Rust attach the per-remote code (e.g. a `detail` list of `{remote, code}` on the fetch `CommandError`) and let `gitError.ts` only format; delete `transportCodeOf` and the five regexes.
- Confidence: medium

### A4-7 — `GitTransportAuthRef` is a flat all-optional TS interface; Rust is a tagged enum with required per-mode fields
- Priority: P2 (API callers will misuse)
- Smell: Data Class mirroring a union as a bag of optionals (Temporary Field)
- Where: src/lib/api/git/types/auth.ts:22-42; src-tauri/src/git/types/auth.rs:78-139; builders src/store/accounts/transportAuth.ts:242-326, src/features/onboarding/flows/cloneAuth.ts:100-150, src/features/onboarding/flows/clone-flow/runClone.ts:134-141
- Evidence: Rust's `#[serde(tag = "mode")] enum GitTransportAuthRef` requires `account_ref` for `githubGh`, `provider` for `gitlabGlab`, and `username`+`provider`+`provider_account_id` for `providerToken` (auth.rs doc: "`githubGh` cannot arrive without its account ref"). The TS type makes all of these optional on one interface, and unlike the other bundled request types (`schemas/requests.ts`) there is no strict schema for it, so `{mode:"providerToken", host, credentialHost}` typechecks and is rejected by serde at IPC time as an opaque deserialization error on clone/fetch/pull/push.
- Consequence: the invariant the Rust enum encodes is enforced only at runtime, far from the five builder sites.
- Fix: Replace Type Code with Subclasses (discriminated union) — declare `GitTransportAuthRef` as a TS union with one member per `mode`, mirroring the Rust variants field for field. This is ~30 hand-written lines and independent of the deferred IPC-codegen (tauri-specta/schemars) decision; it fixes the one place the hand-written mirror is structurally wrong today.
- Confidence: high

### A7-8 — `repo_file_text` failures classified by regex on the message
- Priority: P2 (inconsistent / costly to change)
- Smell: Primitive Obsession (text-parsing an error the contract says to classify by kind/code)
- Where: src/store/repoFilesActions.ts:34-35, used at 200-206; backend src-tauri/src/commands/files.rs:25-29 (`map_err(|e| e.to_string())`), src-tauri/src/git/status/files.rs:96-106
- Evidence: `isMissingFileError = /no such file|not found|cannot find|does not exist|enoent|non-regular/i.test(String(e))` decides whether a reload closes the viewer. The rejection arrives as `kind:"internal"` with OS text; lib/api/invoke.ts:1-5 states the frontend branches on `kind`/`code` "without ever parsing git/gh text", and `initMissingRepo` already uses a backend `code` (repoLifecycleActions.ts:275).
- Consequence: a localized or differently-worded OS error (or a new wording in `open_regular_worktree_file`) leaves a deleted file's stale content on screen; any error containing "not found" closes the viewer.
- Fix: Replace Error Code with a classified error — add a `code` (e.g. `fileMissing`) on the backend `repo_file_text` rejection (four-layer change) and test `toCommandError(e).code`.
- Confidence: high

### A7-17 — `mergeOperationStatus` hand-lists the operation kinds the type already defines
- Priority: P3 (polish)
- Smell: Switch Statements (hard-coded variant list)
- Where: src/store/operation.ts:29-37; type src/store/repoTypes/views.ts:39 (`ActiveOperationKind = Exclude<OperationKind, "none">`); second list at operation.ts:67-79 (`operationLabel`)
- Evidence: runtime check enumerates `merge|rebase|cherry-pick|revert|carry`; a new backend `OperationKind` compiles fine but is silently dropped (no conflict workspace).
- Consequence: adding an operation kind needs a silent runtime edit the compiler does not flag.
- Fix: Replace Conditional with a single `ACTIVE_OPERATION_KINDS` const typed `readonly ActiveOperationKind[]` (checked `satisfies` exhaustive), or test `kind !== "none"` against the parsed enum.
- Confidence: medium
