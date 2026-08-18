## Context

See proposal.md for motivation and `specs/forge/origin/spec.md` for behavior. Today `classify_host` does not know `origin.cursor.com`, so an Origin remote reaches `GhProvider`. Git history already uses git/libgit2 and remains independent of the PR provider.

Existing PR Tauri commands already enter through `forge::context()`. The first slice therefore needs a new provider, shared DTO mapping, auth/readiness chrome, and action gates—not new IPC commands.

`parsing.rs` and `service.rs` are already over the Rust merge ceiling; each receives only the required enum/match changes. Origin implementation stays under `git/forge/origin/`.

## Goals / Non-Goals

**Goals:**

- Detect `origin.cursor.com` and select `OriginProvider`.
- List and inspect PRs, commits, diffs, discussion comments, and existing review threads.
- Reply to, resolve, and reopen existing threads.
- Use the Origin CLI session without exposing or owning its token.
- Show accurate Origin auth/readiness state in existing frontend surfaces.
- Keep git transport on the system helper or SSH.

**Non-Goals:**

- Origin PR create/edit/ready/merge/close/reopen/review/general-comment writes in this slice.
- A Rust `HttpTransport` client or GitLane-owned Cursor token.
- New Tauri commands, Zustand stores, services, dependencies, or credential modes.
- New line-anchored threads, stacks, reviewer management, or repository administration.

## Decisions

### 1. Provider selection stays behind `forge::context()`

Add `ForgeKind::CursorOrigin` with key `"cursor-origin"` and label `"Cursor Origin"`. `classify_host` recognises `origin.cursor.com`; `provider_for` maps it to a static `OriginProvider`. Unknown hosts retain the current `GhProvider` fallback, while other known unsupported forges still fail explicitly.

Repository identity is parsed from the validated local remote. No Origin or GitHub subprocess runs before host/authority validation.

### 2. One Origin subprocess boundary serves CLI commands and `origin api`

`origin/command.rs` owns the only `Command::new("origin")`, using `crate::shell::path()`, `clear_repository_local_env`, bounded concurrent output capture, `NO_COLOR`, and secret redaction.

All structured reads that have a documented REST shape use `origin api` through that same helper. This is not a second HTTP client: authentication and transport remain owned by the Origin CLI. Use direct PR commands where they provide the better contract:

- `pr diff --patch` for the shared unified-diff parser.
- `pr thread list|reply|resolve|reopen` for existing threads.

Keep flags scoped to the subcommand that supports them. Repository selectors and JSON fields belong on PR/API operations; `--version`, help, and auth probes do not receive unrelated `-R`, `--json`, or confirmation flags.

### 3. The first slice implements reads and existing-thread operations only

`OriginProvider` implements repository resolution, list, detail, commits, diff, and review-thread reads. It implements reply/resolve/reopen for existing threads. Required provider methods for create, merge, review, general comment, and lifecycle state return `self.unsupported(...)`.

The frontend enables the PR list/detail surface for Origin but hides deferred write actions. This avoids adding the missing edit IPC contract merely for an operation outside the first slice.

Suggested module layout, following existing forge adapters:

- `origin/mod.rs` — `OriginProvider` and explicit unsupported methods
- `origin/command.rs` — subprocess boundary
- `origin/capabilities.rs` — cached version/help feature probe
- `origin/dto.rs` — serde shapes and checked string-number parsing
- `origin/ops.rs` — read and existing-thread operations

### 4. Auth uses the CLI session and existing accounts store

Add an Origin `ProviderSpec` for `origin auth status`, `origin auth login`, and `origin auth logout`. Add a `fetch_account("cursor-origin")` path using the documented machine-readable Origin current-user command/API; keep only non-secret login/display metadata.

The Origin adapter inherits the user's CLI session/environment. It never extracts a token from auth output, sets `CURSOR_AUTH_TOKEN`, adds `--auth-token`, or copies a token into arguments, IPC, Zustand, logs, or errors.

Frontend work extends the existing accounts slice with an Origin PR-readiness/label selector (parallel to `gitlabPr`, no new store), plus:

- `ForgeAuthProvider` and forge-help capability sets
- Origin whoami and sign-out support
- `prAccountRef()` returning `null` for Origin so the backend uses the CLI session
- Origin readiness in provider-state derivation and PR polling dependencies
- Origin-specific provider popover and remotes-summary copy instead of GitHub or “No PRs” fallback text

### 5. Git transport remains provider-independent

Origin HTTPS remotes keep the existing system-helper path; SSH uses keys. Do not add `TransportCredential::Origin`, inject `gh auth git-credential`, or mutate git configuration. A future change may add explicit Origin credential plumbing only if a stable need is demonstrated.

### 6. Capability checks isolate beta churn

Before the first Origin PR operation, cache a feature probe covering the installed version and the required PR/API/thread commands. Missing binary, missing capability, or native Windows maps to an actionable Origin-specific error with the install/update URL and never falls back to `gh`.

Document JSON fields centrally in `dto.rs`/`ops.rs`. Parse string-encoded PR numbers with checked `u64` conversion and fail clearly on invalid or overflowing values.

## Risks / Trade-offs

- **[Risk] Origin CLI/API shapes change during beta** → One adapter, centralized DTOs/fields, and a feature probe contain churn.
- **[Risk] Origin is absent from the GUI PATH** → Reuse `crate::shell::path()` and show the install command/URL.
- **[Risk] Auth chrome says connected while PR calls fail** → Derive readiness from the same Origin auth probe and key PR polling on that readiness.
- **[Risk] A stale GitHub account remains bound after a remote changes to Origin** → `validate_repository_authority` rejects the host mismatch before any provider subprocess.
- **[Trade-off] Lifecycle writes are deferred** → The first slice delivers browse/review-thread value without inventing edit IPC or committing to unstable write flags.

## Migration Plan

The change is additive: add the forge kind, provider, and gates. Existing GitHub, GitLab, and Bitbucket behavior remains unchanged. Rollback removes the adapter and returns Origin to the current unknown-host behavior. No data migration or localStorage migration is required.

## Open Questions

- Confirm the stable Origin browser URL returned by the CLI/API before wiring external links.
- Record the minimum feature-capable Origin version from the apply-time capability probe.
