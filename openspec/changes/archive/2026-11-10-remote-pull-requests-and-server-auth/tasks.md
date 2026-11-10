# Tasks

## 1. Stale tooltip (bug fix)

- [x] 1.1 In `src/components/chrome/action-bar/RemoteHostIndicator.tsx`, rewrite the `title` to say Git runs on the server with the server's credentials and config, and that file editing, OS openers and agents are unavailable. It must no longer say the terminal or pull requests are off. Also update the component's doc comment, which says pull requests "do not apply". Verify: a test in `ActionBar.test.tsx` asserts the tooltip contains neither "terminal" nor "Pull requests" as unavailable.

## 2. Rust: PR commands on the agent

- [x] 2.1 In `src-tauri/src/agent/dispatch.rs`, add `map.remove("account")` to `without_accounts`. Add a test in `agent/dispatch/tests.rs` that a forwarded `list_pull_requests` with an `account` arrives without it.
- [x] 2.2 Move every PR command in `src-tauri/src/commands/registration_tests/remote_split.rs`'s `LOCAL_ONLY` "Pull requests" group into the agent table in `agent/dispatch.rs`, with parameter names matching each fn: `approve_pull_request`, `create_pull_request`, `link_pull_request_stack`, `list_pull_requests`, `merge_pull_request`, `merge_pull_request_stack`, `pull_request_checks`, `pull_request_commits`, `pull_request_detail`, `pull_request_diff`, `pull_request_review_threads`, `pull_request_reviewer_candidates`, `pull_request_stack`, `repository_stacks`, `resolve_review_thread`, `set_pull_request_state`, and any others in that group. Verify: `cargo test registration_tests` passes; that suite checks the split and the signatures.
- [x] 2.3 On the agent build (`cfg(not(feature = "desktop"))`), make the Bitbucket and Cursor Origin providers fail with `unsupportedOnRemote` and a message naming the provider, in `git/forge/service.rs` `provider_for` or the provider entry points. Verify with a unit test under `--no-default-features --features agent`.

## 3. Rust: server forge login probe

- [x] 3.1 Add the `ForgeServerLogin` DTO (`provider`, `host`, `installed`, `supported`, `minVersion`, `login`) in the forge domain module under `src-tauri/src/git/types/`, re-exported flat and camelCase.
- [x] 3.2 Implement `forge_server_login(workdir)` in `src-tauri/src/git/forge/`, re-exported from `forge.rs`:
  - **gh:** `forge::accounts()` plus active, healthy, host-equal matching, as in `transport_auth::pick_server_gh`.
  - **glab:** `glab auth status --hostname`, through the existing glab CLI boundary.
  - **Other providers:** `provider: null`.
  Unit-test it with the existing gh/glab fixtures: logged in, not logged in, missing, too old.
- [x] 3.3 Add `#[tauri::command] async fn forge_server_login(path)` in `commands/pulls.rs` (the PR commands moved there from desktop-only `commands/github.rs`), wrapped in `blocking`. Register it in `lib.rs`'s `generate_handler!` and add it to the agent table. Verify: the registration tests pass.

## 4. Rust: remote auth-failure hint

- [x] 4.1 Add a helper next to `src-tauri/src/remote/ssh_errors.rs`. It takes a host name, a remote host and a forge kind, and appends the server-side fix to an `auth` error: the `gh` / `glab` login command, a credential helper on the server, or an SSH remote URL. Apply it in `remote/forward.rs` to forwarded fetch, pull and push errors of kind `auth`. Unit-test the text for GitHub, GitLab and an unknown host, and check that it never mentions this computer's accounts.

## 5. Frontend

- [x] 5.1 In `src/lib/api/github.ts`, add the `forgeServerLogin(path)` wrapper and its zod schema in `src/lib/api/schemas/`. Add a wrapper test with the inline `vi.hoisted` + `vi.mock` invoke mock.
- [x] 5.2 In `src/store/pulls/list.ts`, remove the `isRemoteLocator` short-circuit, and send no `account` for remote repositories. Update `pulls` tests: a remote repository loads PRs, and the invoke args carry no account.
- [x] 5.3 In `src/components/chrome/action-bar/ActionBar.tsx`, enable the PRs tab for remote repositories. Disable it only for Bitbucket and Cursor Origin remotes, with the tooltip "<Provider> pull requests are unavailable for remote repositories". Update `ActionBar.test.tsx`, which currently asserts PRs are disabled.
- [x] 5.4 In `src/store/remoteSessions.ts`, hold the per-repo probe result. Load it on a remote tab's connect, and refresh it on PR-panel retry. Show "as <login>" in `RemoteHostIndicator`. Add a store test.
- [x] 5.5 Add a server-login hint to the PR panel's empty and error states for remote repositories. It shows the command built from `provider` and `host` (`gh auth login --hostname <host>` / `glab auth login --hostname <host>`), and an install or upgrade line when it is missing or unsupported. It also has an Open terminal button using the existing terminal toggle. Add a render test for each probe state.
- [x] 5.6 Remote PR write actions (merge, approve, create, set state, resolve) show "Runs on <host> as <login>", and are disabled when the login is unknown. Add a render test.

## 6. Docs and checks

- [x] 6.1 Update `CLAUDE.md`'s "Remote repositories over SSH" section: the PR commands are remote-capable, there is the new probe, the credentials hint exists, and Bitbucket and Origin remain off.
- [x] 6.2 Run the checks: `bun check`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all -- --check`, and both `cargo clippy` invocations (desktop and `--no-default-features --features agent`).
- [x] 6.3 Run `bun run tauri dev` against an SSH host with `gh` logged in. Check that PRs list, detail and merge-preview work and the chip shows the login. For the not-signed-in hint, use a throwaway repo whose origin is a GitHub host the server's `gh` isn't signed in to (such as `ghe.github.com`), not a logout of the real login, and check the hint and Open terminal. Check that a Bitbucket origin disables the PRs tab.
