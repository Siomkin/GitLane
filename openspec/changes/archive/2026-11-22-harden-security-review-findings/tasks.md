# Tasks

## 1. ACP Permission Gate & Catalogue Hardening

- [x] 1.1 Record one `read` and one `search` turn from each installed shipped adapter. Design decision 1 records the result: no adapter sent a permission request for either, and every read reported its path. Use the recorded `tool_call` shapes as the test fixtures. Then narrow `AUTO_ALLOW_TOOL_KINDS` in `src-tauri/src/acp.rs` to `&["think"]` and add a `read`/`search` arm to `permission_outcome` in `src-tauri/src/acp/session/permission.rs` that walks every string value in `rawInput` (recursively) and every `locations[].path`, applying the per-candidate rule in design decision 1 (`~`, `.git` component, absolute or `..` outside `cwd`, existing path whose canonical target leaves `cwd` or enters `.git`), with `read` failing closed when no candidate names an existing in-repo file; split the helpers into `acp/session/permission/paths.rs` if the file nears the 400-line ceiling; cover every scenario of the "Kind alone" and "read or search approval" requirements, including a path under an unknown key, a nested array, a symlink escape, a subdirectory `search` under `directory`, a value equal to the repository root, an absolute path to an in-repo symlink into `.git`, and a rejected `fetch`, in `src-tauri/src/acp/session/tests/permission.rs`; verify via `(cd src-tauri && cargo test acp::session)`
- [x] 1.2 Harden `has_shell_metachar` and `DENIED_OPTIONS` in `src-tauri/src/acp/session/permission.rs` to reject `$`, `=(`, ASCII control characters, and `--ext-diff`, and update the `ALLOWED_EXECUTE_GIT` doc comment in `src-tauri/src/acp.rs` to list `--ext-diff`; add tests for `$VAR`, `${VAR}`, `=(cmd)`, `\r`, and `git log -p --ext-diff` in `src-tauri/src/acp/session/tests/permission.rs`; verify via `(cd src-tauri && cargo test acp::session)`
- [x] 1.3 Keep the two `npx` adapters in `src-tauri/src/acp/catalogue.rs` on `@latest` (exact pins were tried and dropped, design decision 3), keep `current_command` moving a saved row with no version onto the `@latest` entry, and make `is_npx_adapter` and `install_for` compare package names with the version removed (`split_version`); cover a bare row, an `@latest` row, a hand-pinned row kept as is, a hand-pinned row matched by `is_npx_adapter` and `install_for`, and the bare scoped name whose only `@` is the scope, in `acp/catalogue.rs`, `src-tauri/src/acp_agents.rs` and `acp/process/tests.rs`; verify via `(cd src-tauri && cargo test acp)`

## 2. Git Push Option-Injection Guard

- [x] 2.1 Call `ensure_operand(remote)?` at the top of `run_push` and `run_push_under` in `src-tauri/src/git/write/remotes/transport.rs`; add regression tests under `src-tauri/src/git/write/tests/remotes/` that set `branch.<name>.pushRemote` and `remote.pushDefault` to a dash-led value and assert `push_branch` refuses before spawning `git push`; verify via `(cd src-tauri && cargo test git::write::tests::remotes)`

## 3. Worktree `.git/` Read Boundary

- [x] 3.1 Add one shared case-insensitive `.git` component check in `src-tauri/src/git/worktree_fs/` and call it from `open_worktree_file` and `open_regular_worktree_file` (`handle.rs`) and `read_regular_worktree_file_bounded` (`reads.rs`), leaving `open_parent_path`, the fingerprint helpers and `open_worktree_append_nofollow` unchanged; add unit tests for `.git/config`, `.GIT/config`, nested `.gIt/`, and an allowed `.gitignore` in `src-tauri/src/git/worktree_fs/tests.rs`, and for `repo_file_text` / `read_binary_blob` under `src-tauri/src/git/status/tests/`; verify via `(cd src-tauri && cargo test worktree_fs && cargo test git::status)`

## 4. Remote-Agent GitHub Credential Authority Validation

- [x] 4.1 Call `validate_credential_authority` on both `remote_host` and `account.host` inside `pick_server_gh` (`src-tauri/src/git/transport_auth.rs`) and update the `gh_helper_config` doc comment in `src-tauri/src/git/credential_bridge.rs` to name both constructors of `TransportCredential::Gh`; add unit tests that a host containing a quote, whitespace, or a shell metacharacter yields no `Gh` credential (host matching is exact apart from case and `www.`, so the account host and remote host in the test are the same malformed value); verify via `(cd src-tauri && cargo test transport_auth)`

## 5. Verification

- [x] 5.1 Run Rust formatting, desktop and remote-agent clippy, and the full Rust test suite: `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo clippy --all-targets --no-default-features --features agent -- -D warnings && cargo test)`
- [x] 5.2 Run workspace size/cycle checks and frontend verification to confirm no regressions: `bun run sizes && bun run cycles && bun check && bun run test`

## 6. Code Review Follow-ups

- [x] 6.1 Reject `execute` path arguments that are absolute, on another drive, climb with `..`, or start with a shell-expanded `~` (git's implicit `--no-index`), with tests in `src-tauri/src/acp/session/tests/permission.rs`
- [x] 6.2 Resolve every `read`/`search` value through its nearest existing ancestor, so globs under in-repo symlinks and Windows drive-relative values are judged where they point, with tests in `src-tauri/src/acp/session/tests/read_search.rs`
- [x] 6.3 Share one `has_git_component` (case-insensitive, plus NTFS aliases) across `worktree_fs`, `write/path_guards.rs`, `write/files.rs` and the ACP gate, with tests in `src-tauri/src/git/worktree_fs/tests.rs`
- [x] 6.4 Store the trimmed host in both `TransportCredential::Gh` constructors, and test a dash-led `branch.<name>.remote` push

## 7. Second Review Follow-ups

- [x] 7.1 Refuse shell expansion in string `execute` commands with a quote-aware scan (globs, parentheses, backslash, `!`, braces other than `@{…}`, word-initial `~` / `=`), judge every argument, long-option value and single-dash tail with `paths::escapes_repo` against the session directory, and accept only a bare `git`, with tests in `src-tauri/src/acp/session/tests/permission.rs`
- [x] 7.2 Judge each whitespace-separated word of a `read`/`search` value and the path inside a `file:` URI, with tests in `src-tauri/src/acp/session/tests/read_search.rs`
- [x] 7.3 Stop `split_version` slicing inside a multi-byte space, with a test in `src-tauri/src/acp/catalogue.rs`
