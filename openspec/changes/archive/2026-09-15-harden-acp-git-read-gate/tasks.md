## 1. Rust impl (`src-tauri/src/acp/session/permission.rs`)

- [x] 1.1 Replace the leading-global denylist in `is_read_only_git` with an allowlist (`--no-pager`, `--no-optional-locks`): any other token starting with `-` before the subcommand returns `false`. Verify with `cargo test acp::session::tests::permission` — `git --git-dir=/x/.git log`, `git --work-tree=/tmp status`, `git --config-env=core.pager=SHELL log`, `git --exec-path=/tmp/bin diff` are rejected; `git --no-pager log -5` still allowed.
- [x] 1.2 Remove the `break` after the subcommand and scan the trailing tokens: return `false` on `--output`, `--output=…`, `--no-index`, `--contents`, or `--contents=…`; `--output-indicator-*` stays allowed. Verify with the same test module.
- [x] 1.3 Thread the session cwd: `answer(writer, method, id, params, cwd: &Path)` in `acp/answer.rs`, passed from `run_session` in `acp/session.rs`; `permission_outcome(params, cwd)` rejects an `execute` call whose `rawInput` has a `cwd`/`workdir`/`dir_path`/`directory`/`working_directory` value that is non-empty and not the session cwd (compare as paths, resolve relative values against `cwd`). Verify `cargo test acp`.
- [x] 1.4 Update the doc comment on `is_read_only_git` to describe the three-part check (program, allowlisted globals, subcommand, denied trailing options).

## 2. Tests (`src-tauri/src/acp/session/tests/permission.rs`)

- [x] 2.1 Add to `rejected` in `allows_only_read_only_git_for_execute_tools`: `git --git-dir=/somewhere/else/.git log`, `git --work-tree=/tmp status`, `git --config-env=core.pager=SHELL log`, `git --exec-path=/tmp/bin diff`, `git diff --output=.git/config`, `git log -1 --format=x --output /tmp/out`, `git diff --no-index /dev/null /etc/hosts`, `git blame --contents /etc/passwd README.md`. Verify the test passes after 1.1–1.2 (and would fail before).
- [x] 2.2 Add to `allowed`: `git diff --output-indicator-new=+` and `git --no-optional-locks status --porcelain`. Verify the test passes.
- [x] 2.3 Add `permission_outcome` cases: `git log` with `workdir: "/other"` → reject; `git diff --staged` with `workdir` equal to the session cwd → allow; `dir_path: "sub"` (relative, inside the cwd) → reject. Verify `cargo test acp::session::tests::permission`.
- [x] 2.4 Add an end-to-end transcript test beside `rejects_an_execute_tool_whose_command_is_not_a_git_read` where the request is `git --git-dir=/other/.git log -p`; assert the reply selects `reject-once`.

## 3. Docs

- [x] 3.1 Extend the doc comment on `ALLOWED_EXECUTE_GIT` in `src-tauri/src/acp.rs` to state that read-only is guaranteed by subcommand + allowlisted globals + denied trailing options, and that adding a subcommand requires checking its file-writing options. Verify by reading the rendered comment (`cargo doc` not required).

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test acp)` passes.
- [x] 4.2 `bun run sizes` passes (no React/Rust file crosses its ceiling).
- [ ] 4.3 Manual: with any ACP agent configured, run Draft on a repo with staged changes and confirm the draft still arrives (the `git diff --staged` approval path is intact).
