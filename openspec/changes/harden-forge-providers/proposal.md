# Proposal

## Why

The 2026-09-28 round-2 audit (`AUDIT.md` at the repo root) found that the four forge providers
and the provider-auth path still disagree with each other, and that three round-1 fixes
(A2-2, A2-3, A2-8, A2-9) were applied to only part of their sites:

- On macOS and Windows the askpass credential broker can drop the password answer, so
  fetch/pull/push/clone in `providerToken` mode fail auth intermittently (item 1, P0).
- Every gh *write* still tells a GitHub Enterprise user to sign in to github.com (item 6).
- Provider web links drop a self-hosted remote's port and scheme (item 7).
- Origin never reports an auth failure as `auth`, its whoami has no timeout, and it maps
  any unknown PR state to Open (items 22, 23, 25).
- glab ignores the validated repository host (24), GitLab hides its diff cap (28),
  Bitbucket reports re-authorize errors as `forge` (27), Origin checks stay Pending
  forever (26), and "output too large" arrives under four codes (45).

No Jira issue exists yet.

## What Changes

- Credential broker: clear the non-blocking mode an accepted socket inherits, and test the
  production listener shape (1). Insulate the credential-helper git runs the same way as
  every other git subprocess (20).
- gh: every write maps errors through `from_command_in(ctx, …)` (6).
- `RepoForge.web_url` keeps the remote's scheme and port (7).
- Origin: a `map_origin_error` that classifies auth failures (22), a bounded whoami (23),
  an explicit state match with an `Other` passthrough (25).
- glab: pin `--hostname` to the validated repository host (24).
- GitLab: a capped MR diff sets `truncated` (28).
- gh reads return `CliError`, so the `outputTooLarge` code survives, and REST maps its
  response-too-large to the same code (45).
- A cancel that arrives after sign-in finished no longer sticks to the next sign-in (72).
- Forge dead code and misleading comments (58, 82 forge part).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `accounts/transport`: the broker answers every well-formed request on every platform.
- `forge/github`: GHES write failures name the repository's host and account.
- `forge/origin`: Origin auth failures are auth errors, the account probe is bounded, and
  unknown PR states pass through.
- `pull-requests/detail`: a provider-capped diff says it is truncated, and provider web
  links keep the remote's authority.
- `platform/git-invocation`: credential-helper git runs get the standard insulation.

## Non-goals

- The forge REST transport dedupe (deferred backlog).
- The decisions listed in design.md (items 26, 27, 74) get no task until a maintainer picks.

## Impact

- **Processes:** Rust (`git/credential_bridge`, `git/credentials.rs`, `git/forge/**`,
  `auth_providers/**`, `git/oauth/mod.rs`). The frontend changes only if item 74 is decided
  (a `truncated` flag on the PR list).
- **IPC:** no new commands. Item 45 changes which `code` some forge errors carry
  (`commandFailed` → `outputTooLarge`). No frontend code branches on it today.
- **Secrets/auth:** items 1 and 20 sit on the token path. The redaction and credential tests
  must pass unchanged, and no new place may read the keychain token.
