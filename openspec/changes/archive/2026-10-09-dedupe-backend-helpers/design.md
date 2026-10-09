# Design

## Context

See proposal.md (Why). The evidence for every copy (each one named with `path:line`) is
under **Findings**. Every edit stays inside the existing engine: git CLI for writes,
libgit2 for reads, and the one subprocess boundary per CLI.

## Goals / Non-Goals

**Goals:** one implementation per helper, with no behaviour change beyond the two noted in
the proposal.

**Non-Goals:** REST dedupe, lease semantics, rename-detection policy.

## Decisions

1. **Lease primitives stay policy-neutral.** `state_lease` returns raw records and
   `LeaseError`. discard-all and hard reset keep their own refusal filters and wording,
   which is the rule the module header already states.
2. **Locks.** `commondir_lock(&'static OnceLock<Mutex<HashMap<PathBuf, &'static Mutex<()>>>>, repo)`
   with `unwrap_or_else(PoisonError::into_inner)`. The stash lock becomes per-commondir
   like its siblings.
3. **Origin lists.** Removing `default` from `OriginPullList.pulls` and
   `OriginThreadList.threads` is intended. An object on stdout that isn't the wrapper now
   fails to parse and falls through to the `Vec` attempt, then errors. This matches
   `OriginCommentList`/`OriginCommitList`.
4. **One CLI boundary each.** `finish_bytes(success, stdout, stderr, truncated, secrets)`
   and `map_capture_error(err, bin, not_found)` live in `bounded_output`. `Command::new`
   stays in `cli/command.rs`, `gitlab/transport.rs` and `origin/command.rs`.
5. **percent module.** `crate::percent::{encode_component, decode_lossy(plus_as_space)}`.
   `redact.rs` calls `decode_lossy(.., false)`, and pkce calls it with `true`.
6. **Needs a decision: A3-22, rename detection.** The commit and range views skip
   `find_similar`, while compare and history apply it. Unifying them changes the cost on
   very large commits. This change leaves it alone. Decide separately.

Stores: none. Size ceiling: `state_lease.rs` grows, while `discard_all/*` and
`hard_reset_lease/*` shrink. Run `bun run sizes`, and split `state_lease` into
`state_lease/` if it crosses the look band.

## Risks / Trade-offs

- [A lease fingerprint changes byte layout during extraction] → Pin the current digests
  with golden tests before moving code, and require them unchanged after the move.
- [Identity pinning is the "who authors the commit" path] → Keep the existing identity
  tests, and add one per former call site that asserts the exact `-c` argv.

## Findings

### A1-5 — Lease primitives `state_lease.rs` was created to deduplicate are still duplicated between discard-all and hard reset
- Priority: P2
- Smell: Duplicate Code (Shotgun Surgery)
- Where: porcelain-v1 `-z` status parser at src-tauri/src/git/write/discard_all/status.rs:11-92 and src-tauri/src/git/write/hard_reset_lease/fingerprint.rs:96-156. Index digest at discard_all/index.rs:10-53 and hard_reset_lease/fingerprint.rs:56-94. Budgeted leaf fingerprint at discard_all/fingerprint.rs:55-90 and hard_reset_lease/fingerprint.rs:166-197. Scope/HEAD header hash at discard_all/fingerprint.rs:101-130 and hard_reset_lease/capture.rs:94-127. HEAD-tree resolve at hard_reset_lease/fingerprint.rs:30-54 and state_lease.rs:318-343 (differ only by `--no-replace-objects`). Also src-tauri/src/git/write/discard_file/hash.rs:56-81 `hash_worktree_fingerprint`, which repeats `state_lease::fingerprint_into` (state_lease.rs:265-292) byte for byte apart from the error.
- Evidence: The `state_lease.rs` header says "the copies drifted — most seriously when the hard-reset lease dropped the post-hashing observation sweep … (GL-302)". The parsers, index walks (same assume-unchanged / skip-worktree / stage refusals), and budget loops are still line-for-line copies that differ only in domain tag and wording.
- Consequence: A fix to rename-record parsing, a new index flag to refuse, or a budget change has to be made twice (three times for the fingerprint encoding), which is the drift that caused GL-302.
- Fix: Extract Method into `state_lease`: `read_porcelain_z(scope) -> Vec<(code, path, Option<orig>)>`, `index_digest(repo, domain) -> Result<(digest, stage0_paths), LeaseError>`, `hash_scope_header(state, scope, branch, oid, tree)`, and a `fingerprint_with_budget` that returns `LeaseError`. Callers keep their own filters and wording, so the module stays policy-neutral. (`describe_lease_error` ×2 is documented design and is not flagged.)
- Confidence: high

### A1-6 — The global stash lock bricks every stash operation after one panic; its sibling locks deliberately recover
- Priority: P2
- Smell: Alternative Classes with Different Interfaces (three process locks, two poison policies)
- Where: src-tauri/src/git/write/stashes.rs:26-31 vs src-tauri/src/git/write/index_lock.rs:35-58 and src-tauri/src/git/write/identity.rs:24-48
- Evidence: `lock_stash_writes` does `.lock().map_err(|_| "The stash operation lock is unavailable.")`. The index and identity locks use `.unwrap_or_else(PoisonError::into_inner)`, commented "Preserve serialization after a panic instead of bricking writes for the rest of the process lifetime". The stash lock is also one global mutex rather than per-commondir.
- Consequence: One panic while it is held (stash, pop, drop, branch, handoff, or carry continue/abort, all of which take it) makes every later stash operation in every open repo fail until the app restarts.
- Fix: Extract Method. Move the commondir-keyed leaked-mutex registry, now duplicated verbatim in `index_lock.rs:35-58` and `identity.rs:24-48`, into one `commondir_lock(&'static OnceLock<…>, repo)` helper that uses the recovering poison policy, and use it for the stash lock too.
- Confidence: high

### A1-9 — The repo-identity `-c user.name/-c user.email` + signing pinning is written five times
- Priority: P3
- Smell: Duplicate Code
- Where: src-tauri/src/git/write/commits/create.rs:29-44; src-tauri/src/git/write/conflict_resolution.rs:165-189 (`pinned_operation_identity_args`); src-tauri/src/git/write/squash_range/objects.rs:42-66 (`identity_config_args`); src-tauri/src/git/write/identity.rs:127-141 (`pinned_commit_args`) and 146-160 (`pinned_tag_args`, identical except `SigningOperation::Tag`)
- Evidence: The first three all do `match (name, email) { (Some(n), Some(e)) if !n.is_empty() && !e.is_empty() => Some((n, e)), _ => None }`, push `-c user.name=` / `-c user.email=`, then `extend(pinned_signing_args(…, SigningOperation::Commit))`.
- Consequence: Any change to how a commit's identity is pinned (for example adding a committer override, or a new stale rule) must hit three or five places. This is the security-relevant "who authors the commit" logic, where a missed copy means a wrong author or signer.
- Fix: Extract Method. Add `identity::pinned_author_args(repo, name, email, captured) -> Result<Vec<String>>` and `identity::pinned_card_args(repo, SigningOperation)`, and delete the copies.
- Confidence: high

### A1-15 — Byte-identical sibling helpers
- Priority: P3
- Smell: Duplicate Code
- Where:
  - `run_push` / `run_push_stable`: src-tauri/src/git/write/remotes/transport.rs:55-64 and 66-75. The only `_stable` caller is remotes/push.rs:213, and the name implies a difference that doesn't exist.
  - `apply_hunk_patch` / `apply_line_patch`: src-tauri/src/git/write/patch_staging/runners.rs:49-60 and 62-69.
  - `same_path`: src-tauri/src/git/write/worktree_removal_lease.rs:57-62 and src-tauri/src/git/write/worktrees/paths.rs:11-16.
  - `run_git_stdout` / `run_git_env_stdout`: src-tauri/src/git/write/cli/runners.rs:46-54 and 59-71; the first should be `run_git_env_stdout(repo, args, &[])`, like `run_git`.
  - OID→`stash@{n}` lookup: src-tauri/src/git/write/stashes.rs:164-176 and src-tauri/src/git/write/worktrees/stash.rs:54-60.
  - Short-oid helpers: head.rs:136-138, recovery/refs.rs:23-25, restore_path.rs:146-148, plus inline copies at stash_push.rs:156,168, stashes.rs:171, worktree_removal_lease.rs:245, squash_range/objects.rs:22.
  - Subject/fallback sanitizing: src-tauri/src/git/write/patches.rs:37-47 and 88-98.
  - "Git's cleanup also removed empty untracked director{y|ies}…" message: src-tauri/src/git/write/stashes.rs:332-337 and src-tauri/src/git/write/stash_push.rs:63-68. Also stashes.rs:323-328 builds `--literal-pathspecs` by hand instead of using `run_git_literal_paths`.
  - Ignored-entry count: src-tauri/src/git/write/worktrees/dirty.rs:52-58 and worktree_removal_lease.rs:139-145, with opposite failure policies (0 vs hard error) for the same number shown in the remove-detached list and in the confirm.
- Consequence: Each pair must be edited together, and the renamed or duplicated ones (`run_push_stable`, the ignored-count policy) already mislead.
- Fix: Inline Function / Extract Method. Delete one of each pair and route callers to the survivor.
- Confidence: high

### A1-16 — Optional operands that production never omits, and stale doc text
- Priority: P3
- Smell: Speculative Generality / misleading Comments
- Where: src-tauri/src/git/write/tags.rs:15-21, 27-46 (`sha: Option<&str>`; commands/tags.rs:8,18 always pass `Some`); src-tauri/src/git/write/worktrees/lifecycle.rs:22-46 (`reference: Option<&str>`; commands/worktrees.rs:23 always passes `Some`, so the `(Some, None)` and `(None, None)` arms are dead). Stale text: tags.rs:13-14 says "the 2.43+ this app already assumes elsewhere", but the enforced minimum is 2.36.0 (cli/version.rs:9). remotes/push.rs:125-127 says `push_target` is "Shared by `push_branch` and `force_push`", but neither calls it: `push_branch` uses `push_target_at`, `force_push` uses `push_destination`, and `push_target`'s only caller (`branch_push_remote`, push.rs:117-119) discards the refspec half.
- Consequence: Dead branches and wrong docs about the git floor and push routing mislead maintainers of the write contract.
- Fix: Remove Parameter (make `sha`/`reference` required), delete `push_target` in favour of `push_destination(..).0`, and correct the comments.
- Confidence: high

### A2-10 — Origin wrapper-or-array parsing is repeated 5 times and two copies can silently yield `[]`
- Priority: P2
- Smell: Duplicate Code / sibling DTOs disagreeing
- Where: src-tauri/src/git/forge/origin/ops.rs:192-198, :228-231, :246-254, :280-285; src-tauri/src/git/forge/origin/ops/reviews.rs:25-29; src-tauri/src/git/forge/origin/dto.rs:241-246; src-tauri/src/git/forge/origin/dto/threads.rs:41-45; contrast dto.rs:287-294 and :345-353
- Evidence: each loader tries `parse_json::<Wrapper>` and then `parse_json::<Vec<T>>`. `OriginCommentList` and `OriginCommitList` deliberately have **no** `#[serde(default)]` ("must fail to parse instead of silently yielding []"). `OriginPullList.pulls` has `#[serde(default, alias = "pullRequests")]`, and `OriginThreadList.threads` also has `default`. Those two are the only ones that deviate: the sibling list DTOs at dto.rs:287-294 and :345-353 leave `default` off precisely so this shape fails. So any JSON object on stdout (a renamed wrapper key, `{"error":…}` with exit 0) parses as an empty PR list or empty thread list, and the `Vec` fallback never runs.
- Consequence: if the Origin API shape changes, the PR list and review threads show empty and no error, which is exactly the failure the sibling DTOs guard against.
- Fix: Extract Method `parse_list<W, T>(raw, what)` holding the wrapper-then-array rule once, and remove `default` from `OriginPullList.pulls` and `OriginThreadList.threads` so all five behave alike.
- Confidence: high on the code. Medium on how often Origin emits such a body.

### A2-12 — CLI subprocess plumbing is copied across gh, glab and origin (CLI side, not the backlogged REST dedupe)
- Priority: P3
- Smell: Duplicate Code
- Where: builders src-tauri/src/git/forge/cli/command.rs:14-27, src-tauri/src/git/forge/gitlab/transport.rs:81-90, src-tauri/src/git/forge/origin/command.rs:13-21; finish src-tauri/src/git/forge/cli/command.rs:97-137, src-tauri/src/git/forge/gitlab/transport.rs:109-136, src-tauri/src/git/forge/origin/command.rs:38-64; capture-error map src-tauri/src/git/forge/cli/command.rs:139-152, src-tauri/src/git/forge/gitlab/transport.rs:138-149, src-tauri/src/git/forge/origin/command.rs:66-80
- Evidence: the three `finish_*_bytes` are identical except that gh passes `&[token]` to `redact_secrets_with_values`. The three `map_*_capture_error` are identical except for the binary name and the not-found text. The three builders all set PATH, call `clear_repository_local_env` and `hide_console`.
- Consequence: a change to the success/failure contract (rules §1: "success returns stdout only, untrimmed") must be made three times. The finish logic already has three separate test suites.
- Fix: Extract Method. Move `finish_bytes(success, stdout, stderr, truncated, secrets)` and `map_capture_error(error, probe, bin, not_found_msg)` into `bounded_output`. Keep one `Command::new` per CLI so the one-boundary-per-CLI rule holds.
- Confidence: high

### A2-13 — Remote-walk loop copied 7 times in resolution.rs; `gitlab_project` and `origin_project` differ by one enum value
- Priority: P3
- Smell: Duplicate Code
- Where: src-tauri/src/git/forge/resolution.rs:30-37 (`summary`), :179-186 (`detect`), :219-226 (`github_project`), :255-262 (`remote_api_authority_for_project`), :296-303 (`gitlab_project`), :324-331 (`origin_project`), :358-365 (`bitbucket_repo`); plus src-tauri/src/git/forge/resolution/gh_resolved.rs:32
- Evidence: each one does `Repository::discover` → `default_remote_name` → `ordered_remote_names` → `find_remote` → `[url, pushurl]`. `gitlab_project` (:293-318) and `origin_project` (:321-345) are the same apart from `ForgeKind::GitLab` vs `ForgeKind::CursorOrigin`.
- Consequence: a change to the walk order (e.g. excluding push URLs) has to be made in 7 places, and a new forge adds an 8th.
- Fix: Extract Method `remote_urls(repo) -> impl Iterator<Item=&str>` and Parameterize Method `project_for(path, kind)` to replace `gitlab_project` and `origin_project`.
- Confidence: high

### A2-14 — GraphQL argument builder copied 3 times despite a comment saying it lives in one place
- Priority: P3
- Smell: Duplicate Code / misleading Comment
- Where: src-tauri/src/git/forge/prs.rs:35-59 (`graphql_args`, doc: "so the hostname pinning lives in exactly one place"); src-tauri/src/git/forge/threads.rs:114-135 (`review_threads_args`); src-tauri/src/git/forge/prs/merge.rs:82-103 (`head_ref_args`); the `query_field`/`owner_field`/`name_field`/`number_field` block is repeated at prs/commits.rs:31-34, prs/merge.rs:64-67, prs/stacks.rs:52-55, threads.rs:40-43; cursor-page closure copied at prs/commits.rs:35-67 and threads.rs:44-77
- Evidence: the three builders are byte-identical vectors. The facade's claim is false.
- Consequence: the hostname pinning, which is the security-relevant part, has to be kept right in three builders, each with its own test.
- Fix: Inline Method. Have `threads.rs` and `merge.rs` call `prs::graphql_args` (make it `pub(super)` in the forge tree), and Extract Method for the four-field formatting.
- Confidence: high

### A2-15 — Percent-encoding and decoding implemented 4–6 times
- Priority: P3
- Smell: Duplicate Code
- Where: encode: src-tauri/src/git/forge/gitlab/ops.rs:251-262, src-tauri/src/git/forge/bitbucket/ops.rs:331-342, src-tauri/src/git/oauth/pkce/percent.rs:5-16 (byte-identical); src-tauri/src/git/write/remotes/config.rs:181-191 (same unreserved set, out of slice). Decode: src-tauri/src/git/oauth/pkce/percent.rs:19-47, src-tauri/src/redact.rs:248-270 (the pkce copy also decodes `+`; redact.rs:174-181 adds a third hex parser)
- Evidence: identical RFC 3986 unreserved-set loops.
- Consequence: 4 copies to keep consistent. The decoders already differ on `+`.
- Fix: Extract Method into one crate-level `percent` module (encode_component and decode_lossy with a `plus_as_space` flag), reused by forge, oauth, redact and write/remotes.
- Confidence: high

### A3-10 — handoff marker: stale contract doc, parsing duplicated, two sources of truth for "carry"
- Priority: P2
- Smell: Misleading Comment + Primitive Obsession + Duplicate Code
- Where: git/handoff.rs:5-12 (doc: carry is reported "**only** when the marker AND unmerged entries are both present"; "recording the kept stash's oid"), git/handoff.rs:32-44 (`write_marker(git_dir, stash_oid)` / `read_marker -> Option<String>`), git/conflicts/operation.rs:56-71,94-115, git/write/worktrees/handoff_move.rs:234 (`&kept.join("\n")`), git/write/conflict_resolution.rs:264-272 (parses lines again), git/handoff.rs:21 (`CARRY_KIND = "carry"`) vs git/types/conflicts.rs:16 (`OperationKind::Carry`, serialised "carry")
- Evidence: operation.rs explicitly gates on live stashes and **not** on `has_conflicts()` (lines 57-62), which contradicts the module doc. The marker holds a newline-joined list, but the API names it a single `stash_oid`. Both readers repeat `lines().map(trim).filter(!empty)`. `continue_operation`/`abort_operation` compare a raw `&str` against `CARRY_KIND`, while the read side emits the enum.
- Consequence: A maintainer following the doc would re-add the `has_conflicts()` gate that GL-74 P1 removed. Renaming the enum's wire word without touching `CARRY_KIND` breaks Continue/Abort for carries.
- Fix: Replace Data Value with Object. Have `read_marker` return `Vec<String>` (and take `&[String]` in `write_marker`), rewrite the module doc to the live-stash rule, and derive `CARRY_KIND` from `OperationKind::Carry` (or parse `kind` into `OperationKind` at the command boundary).
- Confidence: high

### A3-14 — `repo_identity` duplicates `identity_from_config`
- Priority: P3
- Smell: Duplicate Code
- Where: git/read/identity.rs:23-44 and 55-91
- Evidence: Both check that name and email are non-empty and read `user.signingkey`, `gpg.format`, `commit.gpgsign` and `tag.gpgsign` with the same filters. `repo_identity` is exactly `identity_from_config(&local)`.
- Consequence: A new identity field (for example `gpg.ssh.program`) has to be added in two places or the local and default identities disagree.
- Fix: Extract Method. Replace the body of `repo_identity` after `open_level(Local)` with `Ok(identity_from_config(&local))`.
- Confidence: high

### A3-16 — Config I/O duplicated between `acp_agents` and `terminal_agents`
- Priority: P3
- Smell: Duplicate Code
- Where: acp_agents.rs:107-111 (`data_dir`) + 228-241 (`save_entries_in` tmp+rename) vs terminal_agents.rs:32-36 (`data_dir`) + 41-49 (`write_atomically`)
- Evidence: Same `app_data_dir` resolution and error text, same `create_dir_all` + `json.tmp` + `rename`.
- Consequence: Any hardening (fsync before rename, a Windows rename-over-existing fallback) has to be made twice.
- Fix: Extract Function. Make `terminal_agents::{data_dir, write_atomically}` `pub(crate)` (or move them to a small `app_config` helper) and call them from `acp_agents`.
- Confidence: high

### A3-17 — `worktree_fs::meta::path_bytes` duplicates the "defined once" `os_bytes`
- Priority: P3
- Smell: Duplicate Code
- Where: git/worktree_fs/meta.rs:105-121 vs git/write/state_lease.rs:117-129 (re-exported at git/mod.rs:70-74 with the comment "The two encodings every state token in this layer shares … Defined once")
- Evidence: Byte-for-byte the same per-platform rule (unix `as_bytes`, Windows UTF-16LE, else lossy), used for symlink-target fingerprints at fingerprint.rs:129,216.
- Consequence: If one encoding changes, symlink fingerprints stop matching the other leases' encoding, which contradicts the GL-376 "defined once" claim.
- Fix: Inline Method. Delete `path_bytes` and call `crate::git::os_bytes(target.as_os_str())`.
- Confidence: high

### A3-18 — Stash-precedence and blob-lookup logic written four times
- Priority: P3
- Smell: Duplicate Code
- Where: git/status/stash.rs:40-63 (`blob_carrier_oid`: WIP > untracked > index), 66-95 (`stash_files`: WIP > index > untracked), 98-150 (`stash_file_diff`: WIP > untracked > index), 154-202 (`stash_file_blobs`: WIP > index > untracked). `blob_in` is duplicated at stash.rs:255-258 and selection/touches.rs:26-29. The helpers `index_tree`/`untracked_tree` (stash.rs:204-216) are used by only one of the four.
- Evidence: The orders differ, but tracked and untracked paths are disjoint in a stash, so they can't diverge at runtime today. This is duplication only; no wrong result is claimed.
- Consequence: A fourth stash parent or a precedence tweak has to be kept consistent across four functions.
- Fix: Extract Method. Add one `stash_sources(commit) -> [(tree, untracked_flag)]` in precedence order that all four iterate, and keep a single `blob_in`.
- Confidence: high

### A3-20 — `migrate_builtin_presets` picks the replacement preset by list position
- Priority: P3
- Smell: Temporal/positional coupling (fragile invariant)
- Where: terminal_agents/agents.rs:124-138 (`defaults().pop().expect("defaults include the Codex preset")`)
- Evidence: `pop()` returns whatever preset is last, not the Codex one the `expect` message assumes.
- Consequence: Appending a fifth default preset silently rewrites every untouched legacy Codex row into that new preset.
- Fix: Replace Magic Position with a lookup: `defaults().into_iter().find(|e| e.id == "codex-gpt-5-6-sol-light")`.
- Confidence: high

### A3-22 — Rename detection differs between commit/range views and compare/history views
- Priority: P3
- Smell: Sibling implementations that disagree
- Where: git/status/commit.rs:34-36 and git/status/range.rs:25-27 (no `find_similar`) vs git/status/compare.rs:49, git/status/history.rs:86, git/status/working.rs:68,89 (all call `find_similar`)
- Evidence: The same moved file shows as `R` in compare, history and working views, but as `D` + `A` in the commit inspector and range review (`StackedReview`).
- Consequence: The views disagree for one commit. Row actions keyed on `previous_path` never fire in the commit view.
- Fix: Consolidate Duplicate Conditional Fragments by applying `find_similar` in one shared tree-diff helper. This may be a deliberate cost trade-off on big commits, so decide explicitly.
- Confidence: medium
