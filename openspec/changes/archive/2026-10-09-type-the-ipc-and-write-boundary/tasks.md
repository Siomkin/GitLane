# Tasks

## 1. Closed-set enums (A2-5, A1-3, A1-10, A7-17)

- [x] 1.1 Add `MergeMethod` and `PrStateAction` to `git/types/forge.rs` (serde, camelCase wire strings unchanged), take them in `commands/github.rs`, and make the gh, GitLab, Bitbucket and Origin adapters match exhaustively; delete the `_ => "close"` / `_ => "--merge"` fallbacks and the "historical behaviour" test. Verify with a command test showing that `"bogus"` fails to deserialize.
- [x] 1.2 Deserialize `ResetToRequest.mode` into `ResetMode` and use it in `write/recovery/reset.rs::preview_reset`; verify with a test that `"keep"` fails at preview.
- [x] 1.3 Derive `Deserialize` on `OperationKind`, add `subcommand()`, take it in `commands/conflicts.rs`, and collapse the three tables in `write/conflict_resolution.rs`; verify with `cargo test conflict_resolution`.
- [x] 1.4 Narrow the TS wrapper parameter types in `src/lib/api/` and add `ACTIVE_OPERATION_KINDS` for `mergeOperationStatus`; verify with `bunx tsc --noEmit`.

## 2. libgit2 error kinds (A1-8, A3-2)

- [x] 2.1 Remove the `.map_err(|e| e.to_string())` calls in `commands/{conflicts,files,identity,repo,status}.rs`; verify with `cargo clippy -D warnings` and a command test expecting `notARepository` from a non-repo path.
- [x] 2.2 Map `ErrorClass::Os` to `Internal` in `git/types/error.rs` and update the pinned test; verify with a `repoMissing` store test in which a deleted folder still reaches the missing state through the `openRepo` re-probe.

## 3. Stale leases and substring control flow (A1-2, A1-4, A2-9, A4-5, A7-8)

- [x] 3.1 Add `stale(msg)` to `write/classify.rs` and route every lease message listed in A1-2 through it; verify with the grep test and a `classify` test that each wording maps to `staleLease`.
- [x] 3.2 Make `credential_for_remote` return `Ok(None)` for a URL-less remote and delete the substring match in `commands/remotes.rs`; make the worktree-removal lease `capture` return `Stale | Other`; verify with `cargo test fetch` and `cargo test worktree_removal_lease`.
- [x] 3.3 Add `GithubError::Capture(CaptureError)` and return it from the gh, glab and origin finishers; verify with a test that an oversized diff arrives as `code: "outputTooLarge"`.
- [x] 3.4 Attach per-remote transport codes to fetch's `CommandError`, extend the TS zod schema, and delete `transportCodeOf` and its regexes from `src/lib/gitError.ts`; verify with `gitError.test.ts`, which formats from `detail` only.
- [x] 3.5 Add `code: "fileMissing"` to `repo_file_text` failures and switch the store reader to `toCommandError(e).code`; verify with a store test.

## 4. TS mirror (A4-7)

- [x] 4.1 Rewrite `GitTransportAuthRef` in `src/lib/api` as a discriminated union on `mode` matching the Rust variants; verify with `bunx tsc --noEmit`, and a `@ts-expect-error` test showing that a `providerToken` ref without `providerAccountId` fails to compile.

## 5. Integration

- [x] 5.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`; all exit 0.
- [ ] 5.2 In `bun run tauri dev`, trigger a stale hard reset (edit a file between preview and confirm) and confirm the stale-lease refresh prompt; fetch with a URL-less bound remote and confirm the fetch still succeeds. — manual, pending

## Notes

Deviations from design.md, recorded while applying (base 517070c9):

- **1.1 / 1.2 placement.** `MergeMethod`, `PrStateAction` and `ResetMode` live in
  `git/types/requests.rs` (a "closed-set command arguments" section), not
  `git/types/forge.rs`: adding them to `forge.rs` pushed it over the 400-line
  ceiling (`bun run sizes`). `ResetMode` moved there from `write/reset.rs`
  (`ResetMode::parse` deleted — serde is now the one parser), and
  `preview_reset` takes `ResetMode` at the command too. The "bogus"/"keep"
  deserialize tests sit in `requests.rs`'s test module rather than a command
  test: Tauri deserializes command args with the same serde impl.
  The "unknown method/action" tests that pinned the old fallbacks were deleted
  (gh `set_pr_state_args`, gh `merge_pr_args`, `merge_async_method`, Origin's
  empty-method case, and the write-layer "fold" reset-mode tests) — those
  inputs are now unrepresentable.
- **1.3.** `OperationKind` also gained `as_str()` (the wire word, used for the
  unchanged "Aborted {kind}" / "cannot skip a {kind} operation" copy);
  `handoff::CARRY_KIND` is deleted. `branch_checkout.rs`'s serde round-trip was
  left alone (it also serves `OperationAdvisory`).
- **1.4.** The PR wrappers already took the `MergeMethod` / `PrStateAction`
  unions (already on latest, 517070c9); only `ResetMode` was added to
  `src/lib/api`. `ACTIVE_OPERATION_KINDS` is a `Record<ActiveOperationKind, true>`
  (`satisfies`), not a `readonly` array — a record makes a *missing* kind a
  compile error, which an array `satisfies` check cannot.
- **2.1.** The notARepository command test calls `commands::status::working_changes`.
- **2.2.** Verified the re-probe still works: `open_repo`'s `Missing` kind comes
  from a filesystem presence probe (`read/repo.rs`, `Presence::Gone`), not from
  the git2 error class.
- **3.1 wording.** The canonical suffix is `"Refresh and try again."` (already
  the tail of head/identity/worktree lifecycle messages, which stay
  byte-identical). The A1-2 sites that ended in "Preview … again." /
  "refresh the diff and try again" now end with the suffix instead (`stale()`,
  or spelled out in the three `const` messages). `STALE_LEASE_MARKERS` collapsed
  to the one `STALE_SUFFIX`. The guard test walks `src/git/write/**` production
  code and asserts every string literal containing the word "again" classifies
  as `staleLease` unless listed in a small `NOT_A_LEASE` allowlist (preview
  races, move-aside refusals, the partial worktree-removal success).
- **3.2.** This change only did the `worktree_removal_lease::capture` half.
  The `lifecycle.rs` "Deleted {branch}" comparison from A1-4 was fixed
  separately in PR #465: `deleted_branch_config_warning` returns
  `Option<String>`, decided by the cleanup `Result`. The same PR stopped
  treating `git config --remove-section` exit 128 as "no such section", which
  had hidden fatal config errors.
- **3.3.** `GithubError` lost its `Clone`/`PartialEq`/`Eq` derives (`CaptureError`
  holds `io::Error`; only five test asserts used equality — rewritten). The
  runners (`run_gh*`, `run_glab*`, `run_origin*`) now return a new
  `bounded_output::CliError { Capture { tool, error } | Failed(String) }`;
  `GithubError::from_command` takes `impl Into<CliError>`. The typed error
  reaches IPC on every glab and Origin call and on gh `pr diff`; other gh calls
  that return `Result<_, String>` still stringify it via `From<CliError> for
  String` (unchanged text). A spawn failure other than NotFound keeps its
  "failed to launch …" string. `CaptureError` widened to `pub(crate)` so
  `git/types/error.rs` can match the variant. The typed message comes from
  `CaptureError`'s own `Display` ("stdout exceeded the …-byte output limit"),
  so it no longer names the CLI ("gh stdout exceeded …").
- **3.4 field name.** `CommandError.detail` is already `Option<String>`, so the
  per-remote codes ride on a new optional `remoteFailures: [{ remote, code? }]`
  field (Rust `remote_failures`, skipped when empty). There is no zod schema
  for `CommandError`; the hand-written `asPayload` parser in
  `src/lib/api/invoke.ts` was extended instead. `fetch` returns
  `FetchFailure { output, remotes }`, converted by `From<FetchFailure> for
  CommandError` (combined text still classified as a whole).
- **3.5.** `repo_file_text` returns `RepoFileTextError { Missing | Read }`;
  missing = io `NotFound` / `NotADirectory` or a non-regular leaf. Kind stays
  `internal`, `code: "fileMissing"`. The new `not-a-dir/child.txt` assertion
  relies on the OS reporting `NotADirectory`/`NotFound`; watch it on Windows. The store test lives in
  `FilesPanel.test.tsx`, where the `reloadFileView` tests already were.
- **4.1.** The union dropped the `provider` field the frontend used to put on
  `credentialHelper` and `githubGh` refs (Rust has no such field and ignored
  it); builders and their test expectations were updated. Added a
  `GitlabGlabAuthRef` alias for the two `gitlabGlab` builders.
