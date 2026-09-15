## Why

GitLane's account model promises that the account bound to a remote (the HTTPS URL username) is the one that authenticates fetch/pull/push, and that a bound account's token is only ever presented to the repository GitLane validated for it. Two leads from security audit run-2 show places where an ambient or repo-controlled input can decide instead:

- `git/write/cli/command.rs:git_command:inherited-provider-token-env-overrides-injected-helper` — when the bound account resolves to `gh`/`glab` as the credential helper, that helper runs as a child of GitLane's git subprocess and inherits GitLane's whole environment. `gh` treats `GH_TOKEN` / `GITHUB_TOKEN` (and `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` for GHES hosts) as the active credential, and `glab` does the same with `GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN` / `OAUTH_TOKEN` (both per their own `help environment` / `auth login --help`), overriding the account the URL username selects. A shell or parent that launched GitLane with one of those set makes transport authenticate as that token's principal while the UI still shows the bound account. GitLane already clears inherited commit-identity and repository-routing variables for the same reason; provider tokens are the missing member of that family.
- `src-tauri/src/git/forge/prs/stacks.rs:link_stack:unpinned-repo-authority-gh-extension` — every tokened `gh` call pins `--repo <host/owner/name>` from the validated context, except `gh stack link`, which takes no `--repo` and lets the third-party extension derive the repository and host from the workdir's `.git/config` while holding the account token in its environment. GitLane's own base-repo derivation ignores a `gh-resolved` key on a non-GitHub remote; gh's may not, so the validated host and the host that receives the token can differ. The same call has a second unpinned input: `gh_command` scrubs `GIT_DIR` and its siblings but not `GH_REPO` / `GH_HOST`, so a launching shell that exports `GH_REPO` already redirects `gh stack link` today (every other `gh` call passes `--repo`, which wins over the variable).

Both are `needs_validation` in the audit because no code was executed; the source path is unambiguous in each case and the fix is a few lines.

Jira: no issue exists yet (create a `GL-xx` Task before implementation and put the key in the branch name).

## What Changes

- Every `git` subprocess GitLane builds (`git_command` and `git_command_bare`) removes inherited provider-token variables — `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, `OAUTH_TOKEN` — alongside the commit-identity variables it already clears, so the `!gh auth git-credential` / `!glab auth git-credential` helper GitLane injects answers from the account the remote URL names. GitLane's own `gh` API invocations are unaffected: they build a separate command and set `GH_TOKEN` deliberately.
- `gh stack link` runs with the validated repository pinned through the environment gh and go-gh extensions honour (`GH_REPO=<host/owner/name>`, `GH_HOST=<host>`), so the token is presented only to the repository GitLane validated for the bound account, and an ambient `GH_REPO` / `GH_HOST` in GitLane's launching environment no longer reaches the extension either. The validated `GithubRepository` is threaded from `GhProvider::link_stack` into `prs::link_stack`, matching how `create_pr` and `stack_merge` already receive it.
- Regression tests for both: the env-clearing assertion extends `git_commands_clear_an_inherited_commit_identity`; the stack-link argv/env builder gets a test in the shape of `stack_merge_targets_the_validated_authority_and_method`.

Rust only. No IPC command, type, or frontend change.

## Capabilities

### New Capabilities
- `forge/github`: what GitLane guarantees when it acts on GitHub with a bound account's token — the token is presented only to the repository and host GitLane validated for that account, never to one inferred from repository-controlled configuration.

### Modified Capabilities
- `platform/git-invocation`: adds the requirement that the account authenticating a network operation is the one bound to the remote, and that a provider token present in GitLane's launching environment does not override it.

## Non-goals

- No change to how the bound account is chosen (URL username, SSH key, provider-token bridge) or displayed.
- No change to `run_gh`'s deliberate `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` export for GitLane's own `gh` API calls.
- No attempt to detect or repair a `gh-resolved` key on a non-GitHub remote; GitLane pins the authority it validated and leaves the user's config alone.
- No fallback implementation of stack linking if the `gh-stack` extension is missing — the existing "install it with `gh extension install github/gh-stack`" message stays.
- Not touching the integrated terminal PTY environment (the user's shell is meant to see their own `GH_TOKEN`).

## Impact

- `src-tauri/src/git/write/cli/command.rs` — a `PROVIDER_TOKEN_ENV_VARS` list cleared in `git_command`/`git_command_bare`.
- `src-tauri/src/git/write/cli.rs` — extended env-clearing test.
- `src-tauri/src/git/forge/prs/stacks.rs`, `src-tauri/src/git/forge/gh_provider.rs`, `src-tauri/src/git/forge/cli/command.rs` — `link_stack` takes the validated repository; `run_gh` gains a variant that pins `GH_REPO`/`GH_HOST`.
- `docs/rules/architecture-rules-rust.md` (or the module doc in `credential_bridge.rs`) — one line stating provider-token env is scrubbed from git children.
- Secrets/auth/IPC risk: the change reduces where a token can flow. No new command carries a secret; `GH_REPO`/`GH_HOST` are non-secret. The bound token still reaches the `gh` child only through the existing `run_gh` env path and is redacted from errors as today.
- Pattern to copy: `COMMIT_IDENTITY_ENV_VARS` + `clear_inherited_identity` for the scrub; `repo_selector` + `stack_merge` for the pinned call.
