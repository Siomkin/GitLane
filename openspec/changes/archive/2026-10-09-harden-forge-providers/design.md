# Design

## Context

The evidence for each item (`path:line`, how it was reproduced) is in `AUDIT.md`. This file
cites items by number and keeps only the decisions. Items owned here: 1, 6, 7, 20, 22–28,
45, 58, 72, 74, and the forge part of 82.

## Goals / Non-Goals

**Goals:** the four providers give one meaning to auth failures, PR states, check
conclusions, truncation and host pinning. The credential broker is correct on every
platform.

**Non-Goals:** REST dedupe, new forges, and changes to the capability table from round 1.

## Decisions

1. **Broker socket mode (item 1).** `serve` calls `stream.set_nonblocking(false)` right
   after `accept()`, exactly as `oauth/pkce/loopback.rs:79-85` does. The drip-feed test
   switches to a non-blocking listener so Linux CI exercises the macOS shape. Alternative
   considered: keep the socket non-blocking and loop on `WouldBlock`. Rejected, because it
   re-implements the read timeout the blocking socket already gives.
2. **One gh error mapper (item 6).** Delete `GhProvider::map`. There is no remaining case
   with a repository context that should name github.com.
3. **Web root (item 7).** Build it from `api_host_for(url)` plus the remote's own scheme for
   HTTP(S) remotes. SSH/scp remotes keep `https://{remote_host}`. Origin keeps
   `CURSOR_ORIGIN_WEB_ROOT`.
4. **Origin errors (item 22).** `map_origin_error(operation, err)` mirrors `map_glab_error`:
   known signed-out or 401 text becomes `NotAuthenticated { hint: "Run `origin auth login`" }`,
   and everything else goes through the shared classifier.
5. **glab host pin (item 24).** Pass `--hostname` on every `glab api` call from
   `GlabCli`, built in one argument-builder function with a test, the glab counterpart of
   `gh_api_args`.
6. **Insulation helper (item 20).** Expose the write layer's provider-token env clearing
   and locale pin as one `pub(crate)` function in `write/cli/command.rs`, and call it from
   `credential_git_command`. `PROVIDER_TOKEN_ENV_VARS` stays private behind it.
7. **Sign-in cancel (item 72).** `cancel_sign_in` sets `canceled` only while a flow is
   pending (`starting || child.is_some()` for GitHub, `in_progress` for OAuth). The async
   command arms `starting` before scheduling the blocking worker.

### Needs a decision (no task until decided)

- **Item 26, Origin check conclusions.** Map a `completed` check with an unknown conclusion
  to `Fail` (gh's rule) or keep `Pending`. Fixtures pin `Pending` today.
- **Item 27, Bitbucket 403 kind.** Make the scope 403 `NotAuthenticated` and other 403s
  `PermissionDenied`, or keep `CommandFailed`. A transport test pins today's behaviour.
- **Item 74, PR list caps.** Return `{ prs, truncated }` with one `PR_LIST_LIMIT`, or
  document PR lists as a recent-only view exempt from §1a. Either way the caps differ per
  provider today (50/50/50/100). Choosing the first adds the frontend "more" indicator to
  this change.

## Risks / Trade-offs

- [Item 45 changes error codes] → no frontend code reads `outputTooLarge` yet (grep
  finds only the doc comment in `src/lib/api/git/types/error.ts:46-49`).
- [Item 24 on a checkout where glab's own host pick was right] → the pinned host is the one
  GitLane already validated and shows, so the result can only move to the host the UI
  claims.
