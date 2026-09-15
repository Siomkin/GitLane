## 1. Rust impl — git subprocess env scrub

- [x] 1.1 Add `PROVIDER_TOKEN_ENV_VARS` (`GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN`) and a `clear_inherited_provider_tokens` helper in `src-tauri/src/git/write/cli/command.rs`, with a doc comment explaining why (helpers GitLane injects treat these as the active credential). Verify with `cargo check`.
- [x] 1.2 Call the helper from both `git_command` and `git_command_bare` next to `clear_inherited_identity`. Verify `cargo test git::write::cli` passes.
- [x] 1.3 Extend `git_commands_clear_an_inherited_commit_identity` in `src-tauri/src/git/write/cli.rs` to assert each provider-token var is `None` in `get_envs()` for both builders. Verify the test fails when 1.2 is reverted and passes with it.

## 2. Rust impl — pinned stack link

- [x] 2.1 Add `run_gh_in_repository(workdir, repository: &GithubRepository, args, token)` to `src-tauri/src/git/forge/cli/command.rs` that sets `GH_REPO` (via `repo_selector`) and `GH_HOST` and delegates to `run_gh_with_limit`. Verify with `cargo check`.
- [x] 2.2 Change `prs::link_stack` in `src-tauri/src/git/forge/prs/stacks.rs` to take `&GithubRepository` and use `run_gh_in_repository`; update its doc comment (the "takes no --repo" note now explains the env pin). Verify `cargo check`.
- [x] 2.3 Pass `&ctx.repository` from `GhProvider::link_stack` in `src-tauri/src/git/forge/gh_provider.rs`. Verify `cargo check` and existing `forge` tests pass.
- [x] 2.4 Add a builder test beside `stack_merge_targets_the_validated_authority_and_method` asserting argv `["stack","link","1","2"]` and env `GH_REPO`/`GH_HOST` from the validated repository (no spawn); set a different `GH_REPO` on the test process's environment first (or assert `get_envs()` carries the explicit value) so the test proves the pin overrides an inherited one. If `stacks.rs` crosses the Rust size ceiling, move its tests to `prs/stacks/tests.rs`. Verify `cargo test git::forge::prs::stacks`.

## 3. Docs and manual checks

- [x] 3.1 Add one sentence to the `credential_bridge.rs` module doc (Gh/Glab arms) noting the git child starts without inherited provider-token env, so the URL username is what selects the account. Verify by reading the comment.
- [x] 3.2 Add a line to `docs/rules/architecture-rules-rust.md` next to the existing git-subprocess isolation rule listing provider-token env as cleared. Verify the doc renders.
- [ ] 3.3 Manual: launch `GH_TOKEN=<dummy> bun run tauri dev`, bind a GitHub account to a test remote, fetch — confirm the fetch succeeds as the bound account (previously it would fail or run as the dummy token's principal). Do not use a real token for the dummy value.
- [ ] 3.4 Manual smoke (low priority — `gh-stack` v0.1.0 is already confirmed to read `GH_REPO`/`GH_HOST`, see design Context): with `gh extension install github/gh-stack`, create a two-PR stack from GitLane on a throwaway repo and confirm the link succeeds.

## 4. Definition of done

- [x] 4.1 `(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test git::write::cli git::forge)` passes.
- [x] 4.2 `bun run sizes` passes.
- [ ] 4.3 Release-notes line: GitLane no longer lets a `GH_TOKEN`/`GITLAB_TOKEN` (or their documented aliases) in its launching environment decide which account authenticates fetch/pull/push; users who relied on one without binding an account should bind the account in the Remotes panel.
