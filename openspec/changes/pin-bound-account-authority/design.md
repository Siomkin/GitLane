## Context

See proposal.md — Why.

**Git children.** `git_command` / `git_command_bare` (`src-tauri/src/git/write/cli/command.rs`) build every git subprocess from `isolated_git_command()`. They already call `clear_repository_local_env` (Git's `--local-env-vars` list) and `clear_inherited_identity` (`COMMIT_IDENTITY_ENV_VARS`) and pin `PATH`/`GIT_TERMINAL_PROMPT`/`LC_MESSAGES`. For `TransportCredential::Gh { host }` / `Glab { host }`, `credential_bridge::git_invocation` adds `-c credential.https://<host>.helper=!gh auth git-credential` (or `glab`) with an empty extra env; the helper is spawned by git and inherits the git child's environment. `gh` prefers `GH_TOKEN`/`GITHUB_TOKEN` (`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` on GHES) and `glab` prefers `GITLAB_TOKEN`/`GITLAB_ACCESS_TOKEN`/`OAUTH_TOKEN` over their stored accounts, which defeats the URL-username selection. GitLane's own `gh` API calls use a different builder (`forge/cli/command.rs::gh_command`) and export the token on purpose — they are not affected by scrubbing the git builder.

**Stack link.** `GhProvider::link_stack` receives the validated `GithubContext` (whose `repository` was checked against the bound account's host by `service::context`) and passes only `ctx.workdir` to `prs::link_stack`, which runs `gh stack link <numbers>` through `run_gh` with the token exported as both `GH_TOKEN` and `GH_ENTERPRISE_TOKEN`. `gh stack` is an extension (github/gh-stack, Go, built on go-gh); it takes no `--repo`, so it resolves the repository itself from cwd. go-gh's repository resolution honours `GH_REPO` ahead of git remotes, and gh's host selection honours `GH_HOST`. `gh_command` (`forge/cli/command.rs`) does not scrub either, so an ambient value from GitLane's launching shell reaches the extension today. The installed `gh-stack` v0.1.0 binary contains both `GH_REPO` and `GH_HOST` and links `go-gh/v2/pkg/repository`, so setting them is honoured (checked with `strings` at planning time).

Engine: forge provider (`gh`) for the link; git CLI for transport. No libgit2. No IPC layer change: `link_pull_request_stack` keeps its signature; the change is internal to the Rust provider. No Zustand store. `command.rs` (~125 lines) and `stacks.rs` (~430 lines incl. tests) have room; `stacks.rs` tests already sit in a `mod tests` in-file — if the new test pushes the file past the Rust ceiling, move the tests to `prs/stacks/tests.rs` per the split-module pattern.

## Goals / Non-Goals

**Goals:**
- Any `git` GitLane spawns starts without inherited provider-token variables.
- `gh stack link` runs with `GH_REPO` and `GH_HOST` set from the validated `GithubRepository`.
- Both guarantees are unit-tested against `Command::get_envs()` and the argv/env builder, without network.

**Non-Goals:**
- Verifying the extension's runtime behaviour in CI (it needs a real `gh` + extension install). One manual check is in tasks.
- Scrubbing anything from the integrated terminal or ACP agent processes.

## Decisions

**D1 — Scrub in the git builder, not per transport credential.**
Add `PROVIDER_TOKEN_ENV_VARS: &[&str] = &["GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN","GITLAB_TOKEN","GITLAB_ACCESS_TOKEN","OAUTH_TOKEN"]` (the names `gh help environment` and `glab auth login --help` document; `GLAB_TOKEN` is not one glab reads and is left out) next to `COMMIT_IDENTITY_ENV_VARS` and clear it from `git_command` and `git_command_bare`. *Alternative:* remove them only in `run_transport` when the credential is `Gh`/`Glab` (would need `GitInvocation` to grow an `env_remove` list). Rejected: GitLane never wants an ambient forge token to decide git auth for *any* remote it drives — a user with a global `credential.helper=!gh auth git-credential` and no bound account would otherwise still be silently authenticated by a stray shell variable, contrary to what the Remotes panel shows. The builder is the single choke point and mirrors the identity precedent. Placed in `command.rs` rather than `isolated_git_command` so `git_output`'s explicit `envs` re-application semantics stay unchanged (same reasoning as the identity vars).

**D2 — Pin the extension via environment, keep argv untouched.**
Thread `&GithubRepository` into `prs::link_stack` and set `GH_REPO=<host>/<owner>/<name>` (from `repo_selector`) and `GH_HOST=<host>` on the `gh` command for this call only. Implement as `run_gh_in_repository(workdir, repository, args, token)` in `forge/cli/command.rs` that sets the two env vars then delegates to `run_gh_with_limit`, so token export and redaction stay in one place. Setting them explicitly also overrides any ambient `GH_REPO`/`GH_HOST` GitLane inherited, which is the second cause named in the proposal. *Alternative:* refuse to link when the workdir's derived repository differs from the validated one. Rejected as primary: GitLane's derivation already agrees with the validated authority by construction; the divergence is in gh's derivation, which `GH_REPO` overrides directly. *Alternative:* pass `-R`. Not accepted by `gh stack link`.

**D3 — Do not set `GH_REPO` on other `run_gh` calls.**
They already pass `--repo`; adding env would be redundant and widen the diff. Scope the pin to the one call that lacks a selector.

**D4 — Tests follow existing seams.**
`git_commands_clear_an_inherited_commit_identity` (write/cli.rs) gains assertions that `get_envs()` yields `None` for each provider-token var on `git_command(".")` and `git_command_bare`. `stacks.rs` gains a test alongside `stack_merge_targets_the_validated_authority_and_method` asserting the built command has `GH_REPO`/`GH_HOST` from the repository and argv `["stack","link","1","2"]`. Neither spawns a process.

## Risks / Trade-offs

- [A user relied on an ambient `GH_TOKEN` to make GitLane's git pushes work without binding an account] → After the change their push falls through to gh's stored accounts or their credential helper, which is what the Remotes panel says will happen. Release note line; the fix is to bind the account.
- [gh-stack ignores `GH_REPO`] → go-gh's `repository.Current()` documents `GH_REPO` precedence and the installed extension binary references both variables (see Context), so this is low risk; task 3.4 is a single smoke run, not the verification. If a future extension version drops go-gh, fall back to the refuse-on-divergence alternative in D2 (a follow-up, since it changes behaviour).
- [`GH_HOST` also steers which token env name gh reads] → `run_gh` already exports the token under both names, so pinning the host is harmless.

## Migration Plan

None. No persisted state or IPC contract changes. Normal release.
