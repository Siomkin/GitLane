# Proposal

## Why

The 2026-09-25 audit found dead code, misleading comments, and pure duplication across
both processes. Each removal is proven with a grep across `src`, `src-tauri`, the tests,
`docs` and `scripts`, allowing for `generate_handler!`, serde and dynamic `invoke`. These
are code nobody reaches, comments that describe behaviour the code no longer has, and
copies that must be edited together. None changes behaviour. No Jira issue exists yet.

## What Changes

- **Delete unreachable code:**
  - `credential_helper_status` across all four IPC layers.
  - `HeadLease`'s serde derives and wire test.
  - The one-variant `CleanupKind` and the always-false `include_ignored`.
  - The duplicate thread-placement test in `commands/github.rs`.
  - Unused Windows imports in `discard_file`.
  - A no-op Origin test and an unreachable `transport_auth` arm.
  - The unused `commits` parameter on GitLab/Bitbucket `into_detail`.
  - `build_profiled` (test-only).
  - The settings `identity.ts`, `connectState`, the `helperOnly` prop, the remove-worktree
    `force` field, and assorted unused exports, props, icons and barrel entries.
- **Native-OAuth sign-in UI (A8-8): decided upstream in #448** — the connect method and zero-reference helpers were deleted, and the dialog chain is kept as a future entry point. The original finding: Its render
  site was removed in dfac0d13, and nothing reaches `OauthMethod` or
  `openProviderOauthSignin`. But CLAUDE.md, `docs/provider-oauth-setup.md` and the
  archived `harden-provider-oauth-sign-in` all describe it as shipped. Either re-expose it
  from Accounts, or delete the UI chain and correct the docs. The Rust OAuth flows stay in
  both cases. The zero-reference helpers (`OAUTH_PROVIDERS`, `isOauthProvider`,
  `useOauthConfigured`, `StateBlock`, `ShieldIcon`) are deleted either way.
- **Correct stale comments and copy:**
  - The forge module docs and `service.rs` keys.
  - "Synchronous" command wording.
  - `RemoteInfo.is_default` ("fetch/upstream", not "push").
  - The IPC seam comments and the `events.ts` `assertEqual` copy.
  - Store comments.
  - The menu lint allowlist.
  - About → "Visual git client" (no "for macOS").
- **Collapse pure duplicates:**
  - Settings draft-list primitives.
  - Inline SVGs → `components/ui/icons`.
  - `LoadError` → `ErrorFallback`.
  - A navigator category descriptor table.
  - Keyed state instead of reset-only effects.
  - `stashEntryFromNode`, one path-tree builder, and history-inspect reusing its extracted
    parts.
  - `AgentRunStatus` action slot.
  - Store `repoDataWipe` / `ReadOwner` / `requestLease` adoption and the shared action
    bodies.
  - Shared dialog outcome chrome.
  - `useWindowMaximized`.
  - `openRepoSettings(section?)` typing.
  - `slugOf` / `repoLabel`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

_None._ `skip_specs: true`. This is pure removal and refactor with no behaviour change.
The OAuth-UI item re-exposes or deletes an unreachable flow; if the decision is to
re-expose it, that part moves to its own spec-bearing change.

## Non-goals

- The Rust native OAuth flows (`git/oauth/`) are not touched.
- Anything that changes behaviour. Those items are in `align-sibling-behaviour`.
- Size-ceiling splits for their own sake.

## Impact

- **Processes:** Rust (dead items under `git/write`, `git/forge`, `git/graph`,
  `commands/`, `transport_auth.rs`), IPC (removing `credential_helper_status` changes all
  four layers plus its `generate_handler!` line), frontend (`src/components/**`,
  `src/features/**`, `src/store/**`, `src/lib/**`), docs (CLAUDE.md GL-139 paragraph and
  `docs/provider-oauth-setup.md`, depending on the OAuth decision).
- **Secrets/auth:** removing `credential_helper_status` shrinks the auth surface. The
  two-secret-command rule is unaffected.
