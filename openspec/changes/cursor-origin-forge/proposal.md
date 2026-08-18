## Why

Cursor Origin (`origin.cursor.com`) is a git forge, but GitLane does not recognise the host. Origin remotes therefore fall through to `GhProvider`, and the PR tab fails with a generic GitHub CLI error instead of using Origin.

**Jira:** none (searched `project = GL` for origin / Cursor Origin / origin.cursor.com).

**Process:** Rust (forge detection + `OriginProvider`) and frontend (PR gates, auth, and provider chrome). Existing PR IPC commands stay; `forge::context()` selects the adapter.

## What Changes

- Classify `origin.cursor.com` as `ForgeKind::CursorOrigin` and dispatch it to a first-class `OriginProvider`.
- Add one `run_origin` subprocess boundary. Use `origin api` for documented structured reads and Origin PR/thread commands for patch and existing-thread operations.
- Deliver the first useful slice: PR list, detail, commits, diff, discussion display, and existing review-thread list/reply/resolve/reopen.
- Probe the Origin CLI session and show its signed-in identity in the existing forge-auth UI. Origin owns credentials; GitLane never extracts, stores, reinjects, or returns Origin tokens.
- Reuse the existing PR UI while hiding or explicitly refusing deferred Origin writes.
- Leave fetch/push on git plus the credential helper installed by `origin auth login`; never inject `gh` credentials for an Origin host.

**Copy, do not invent:** `git/forge/parsing.rs` + `service::provider_for` (detection/dispatch), `git/forge/cli/command.rs` + `GhProvider` (one subprocess site and shared DTO mapping), and GitLab forge-auth/readiness chrome (CLI session, no GitLane-owned token).

## Non-goals

- Creating, editing, marking ready, merging, closing/reopening, approving, requesting changes, or posting new general/line-anchored comments on Origin PRs in this first slice. Required provider methods return Origin-specific unsupported errors and the UI omits those actions.
- Replacing `gh` for `github.com` remotes, including GitHub remotes mirrored to Origin.
- Creating, deleting, or mirroring Origin repositories.
- Native Origin OAuth, storing Cursor tokens, or accepting an Origin token through the forge-auth UI.
- Stacked Origin PRs, reviewer management, webhooks, or live PR events.
- Bundling the `origin` binary, native Windows support, or driving `origin auth login` through an in-app PTY.

## Capabilities

### New Capabilities

- `forge/origin`: Detect Cursor Origin remotes and provide the read-first pull-request and existing-thread surface through the Origin CLI session.

### Modified Capabilities

- None. `openspec/specs/` has no archived capabilities yet.

## Impact

- **Rust:** `ForgeKind`, `classify_host`, `provider_for`, a new `git/forge/origin/` adapter, and Origin auth status/identity mapping.
- **Frontend:** `ForgeKind`, PR gates, remotes classification, forge-auth readiness/identity, provider chrome, and Origin write-action guards.
- **IPC:** no new commands or secret fields; reuse shared `PullRequest*` and review-thread DTOs. Origin string-encoded PR numbers are parsed to the existing `u64` domain type in Rust.
- **Dependencies:** none. Requires a user-installed Origin CLI, which is early beta and may change flags/JSON shapes.
- **Docs/rules:** update the forge lists and provider-auth QA matrix.
