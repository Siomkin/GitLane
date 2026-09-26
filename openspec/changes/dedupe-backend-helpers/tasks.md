# Tasks

## 1. Leases and locks (A1-5, A1-6)

- [x] 1.1 Add golden-digest tests for discard-all and hard-reset lease tokens on a fixture repo; verify they pass on the current code.
- [x] 1.2 Extract `read_porcelain_z`, `index_digest`, `hash_scope_header` and `fingerprint_with_budget` into `write/state_lease.rs`, and route `discard_all/*`, `hard_reset_lease/*` and `discard_file/hash.rs` through them; verify that the 1.1 golden tests and `cargo test discard hard_reset` pass unchanged.
- [x] 1.3 Add `commondir_lock` with the recovering poison policy and use it in `index_lock.rs`, `identity.rs` and `stashes.rs`; verify with a test that panics while holding the stash lock and then stashes successfully.

## 2. Identity and write helpers (A1-9, A1-15, A1-16, A3-10)

- [x] 2.1 Add `identity::pinned_author_args` / `pinned_card_args` and replace the copies in `commits/create.rs`, `conflict_resolution.rs`, `squash_range/objects.rs` and `identity.rs`; verify with argv assertions per call site.
- [x] 2.2 Delete one of each byte-identical pair listed in A1-15, make `tags.rs` `sha` and `worktrees/lifecycle.rs` `reference` required, replace `push_target` with `push_destination(..).0`, and fix the git-floor and push-routing comments; verify with `cargo clippy -D warnings` and `cargo test write`.
- [x] 2.3 Make the handoff marker read/write `Vec<String>`, derive `CARRY_KIND` from `OperationKind::Carry`, and rewrite the module doc; verify with `cargo test handoff`.

## 3. Forge and shared encoders (A2-10, A2-12, A2-13, A2-14, A2-15)

- [x] 3.1 Add `origin::parse_list<W, T>` and remove `default` from `OriginPullList.pulls` / `OriginThreadList.threads`; verify with a test that `{"error":"x"}` on stdout is an error, not `[]`.
- [x] 3.2 — already on latest (862a3fa4, #444: `bounded_output/finish.rs`). Was: move `finish_bytes` / `map_capture_error` into `bounded_output` and call them from the gh, glab and origin boundaries; verify that the three finisher test suites pass and that `rg 'Command::new\("(gh|glab|origin)"'` still finds exactly one site each.
- [x] 3.3 Extract `remote_urls()` and `project_for(path, kind)` in `forge/resolution.rs`, and make `threads.rs` / `prs/merge.rs` call `prs::graphql_args`; verify with `cargo test forge`.
- [x] 3.4 Add `src-tauri/src/percent.rs` and replace the copies in `gitlab/ops.rs`, `bitbucket/ops.rs`, `oauth/pkce/percent.rs`, `write/remotes/config.rs` and `redact.rs`; verify that the redaction and pkce tests pass unchanged.

## 4. Reads and config (A3-14, A3-16, A3-17, A3-18, A3-20)

- [x] 4.1 Make `repo_identity` call `identity_from_config`, delete `worktree_fs::meta::path_bytes` in favour of `os_bytes`, and add one `stash_sources(commit)` used by the four stash lookups; verify with `cargo test`.
- [x] 4.2 Share `terminal_agents::{data_dir, write_atomically}` with `acp_agents`, and pick the migration preset by id in `migrate_builtin_presets`; verify with `cargo test acp_agents terminal_agents`.

## 5. Integration

- [x] 5.1 Run `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test`, and `bun run sizes`; all exit 0.
- [ ] 5.2 In `bun run tauri dev`: stash, pop, discard-all and hard reset on a scratch repo behave as before, and an Origin repo still lists its PRs. — manual, pending

## Notes

- **1.1 golden digests.** A full lease token hashes the temp fixture's paths and
  directory identities, so no constant can pin it. The pin is two layers
  (`discard_all/golden_tests.rs`, `hard_reset_lease/golden_tests.rs`, fixture in
  `state_lease/golden_fixture.rs`): hex constants for both index digests and the
  discard-all header on a synthetic scope, exact status records and budgeted
  fingerprints; plus one test per operation that rebuilds the whole token from the
  byte layout spelled out in the test (only the scope read back). All passed before
  the move and pass unchanged after it.
- **1.2 `hash_scope_header` became `hash_scope` + `hash_head`.** Hard reset hashes
  its `core.ignorecase` byte between the scope and HEAD, discard-all does not, so
  one header function could not serve both. `index_digest` and
  `fingerprint_with_budget` return new `LeaseError` variants (`InspectIndex`,
  `AssumeUnchanged`, `SkipWorktree`, `ConflictedIndex`, `FingerprintLimit`,
  `InspectLeaf`) that each `describe_lease_error` words exactly as before;
  discard-all keeps its per-call-site context and its test byte counter in its own
  wrapper. The HEAD-tree resolve pair (differs by `--no-replace-objects`) is not in
  1.2 and was left alone.
- **`state_lease.rs` is 369 lines (look band).** Its pieces: the `LeaseError`
  vocabulary, `RepositoryScope` + `discover_scope`, the two shared encodings
  (`hash_field`/`os_bytes`), HEAD reads, and the scoped git runners. The new
  primitives live in `state_lease/{status,index,digest}.rs`.
- **1.3** The stash lock is now per commondir (`lock_stash_writes(repo)`), like
  the index and identity locks; a failure to resolve it reads "Failed to resolve
  the repository stash lock: …".
- **2.1** `pinned_signing_args` is now private to `identity.rs`; argv is asserted
  on the two helpers (`identity.rs` tests), and each call site keeps its existing
  behavioural test (`commits/identity.rs`, `conflicts/operation.rs`,
  `squash_range.rs`, `tags`). There is no git argv capture seam to assert per call
  site without adding one.
- **2.2 skipped:** the ignored-entry count pair (`worktrees/dirty.rs` vs
  `worktree_removal_lease.rs`) is not byte-identical — the two have opposite
  failure policies, and unifying them is a behaviour change. Short-oid helpers now
  share `operands::short_oid` (`oid.get(..7)`), which equals the old
  `chars().take(7)` for every hex oid.
- **2.3** `CARRY_KIND` was already gone (0375584b typed `OperationKind` end to end);
  only the `Vec<String>` marker and the module doc were left.
- **3.4 one byte-level difference in `redact.rs`:** its old decoder parsed a hex
  pair with `u8::from_str_radix`, which accepts a leading `+`, so `%+5` decoded to
  `0x05`. The shared `percent::decode_lossy` uses strict hex digits, so `%+5` now
  stays literal, which is what the decoder's own doc comment already promised. No
  redaction test pins it. The `plus_as_space` flag is `false` for redact and
  `true` for pkce, as before. The pkce round-trip test moved into `percent.rs`.
- **4.1** `stash_sources` puts every lookup in one order: worktree, then index,
  then untracked. `blob_carrier_oid` and `stash_file_diff` used to check
  untracked before index. The answer cannot differ, because tracked and
  untracked paths are disjoint in a stash. Also, `blob_carrier_oid` now returns
  the stash commit when *any* stash tree fails to load, where before it treated
  only that one tree as empty. That only matters for corrupt objects.
- **Golden tests are unix-only** (`#[cfg(all(test, unix))]` on the fixture and
  both test modules), because they pin unix file modes.
- **5.1** `bun run sizes` reads `git ls-files`, so the unstaged deletion of
  `oauth/pkce/percent.rs` makes it crash with ENOENT. It was run against a
  temporary index copy that records the deletion and the new files: exit 0. It
  passes on the real index once the change is staged.

