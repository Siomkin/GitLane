# GitHub provider and authentication roadmap

## Status (2026-09)

Phases 1–3 of this document are done. Phase 4 shipped in part as the `gh`
capability preflight (version, auth status, token, `pr diff --patch`, GraphQL).
Native provider-token storage and in-app OAuth shipped for GitLab and Bitbucket
under GL-132 / GL-139; they do not replace `gh` for GitHub. Phases 5–8
(native GitHub OAuth, REST/GraphQL without `gh`) remain undecided. Authorised
PR context is resolved through `forge::context()`.

Do not treat unchecked phase boxes below as a current backlog.

## Decision

For the current GitLane stage, keep the GitHub CLI (`gh`) as the default
authentication owner and GitHub transport.

Do not make native OAuth a prerequisite for the module split. Introduce a narrow
provider boundary first, retain the current behavior through `GhProvider`, and
add a native provider later only when GitLane intentionally supports GitHub
without requiring `gh`.

The target progression is:

```text
Today
  Tauri commands → git::github free functions → gh CLI

Near term
  Tauri commands → GithubService → GithubProvider
                                      └── GhProvider (default)

Long term
  Tauri commands → GithubService → GithubProvider
                                      ├── GhProvider
                                      └── NativeGithubProvider
                                            ├── OAuth/device authorization
                                            ├── OS keychain
                                            └── REST + GraphQL client
```

> **Superseded in part by GL-352.** The `GithubService` step above shipped and was
> then removed: a service that only forwarded to the provider earned nothing, so a
> command now resolves its authorised context once via `forge::context()` and calls
> the returned `GithubProvider` directly. Read `GithubService` below as "the provider
> boundary" — the boundary is what mattered and it still stands; only the object in
> the middle is gone. See `CLAUDE.md` and `docs/rules/architecture-rules.md` for the
> current shape.

## Why keep `gh` now

`gh` currently provides important product behavior beyond basic HTTP:

- account discovery;
- secure credential storage owned by GitHub CLI;
- multiple accounts and hosts;
- SSO-aware tokens;
- GitHub Enterprise configuration;
- merge queue and auto-merge semantics through `gh pr merge`;
- GitHub-specific error messages;
- git credential-helper integration for push/fetch;
- no GitHub token storage responsibility inside GitLane.

Replacing it immediately would exchange subprocess and dependency concerns for
token lifecycle, secure storage, OAuth registration, host discovery, API
versioning, pagination, rate limiting, SSO, and enterprise certificate concerns.

## Problems to address without removing `gh`

- GitLane currently models a selected account primarily as a username.
- `token_for()` is currently tied to `github.com`.
- transport details are exposed through free functions rather than an explicit
  provider contract.
- a large implementation module mixes transport, DTOs, domain behavior, and
  parsing.
- GitLane does not verify a minimum supported `gh` version/capability set.
- errors are strings without a stable category for authentication, version,
  permission, network, or data-shape failures.
- no native authentication path exists for users who do not want to install
  `gh`.

## Goals

- Keep `gh` as the default provider.
- Build on the completed responsibility split (GL-2): the `github/` directory
  module (`cli` / `dto` / `prs` / `threads` / `diff`).
- Introduce a provider-neutral repository/account context.
- Keep secrets entirely in Rust and outside IPC.
- Make provider selection explicit and persisted per account/repository.
- Detect unsupported `gh` versions before feature calls fail unpredictably.
- Permit an opt-in native provider without rewriting frontend PR features.
- Support GitHub.com and GitHub Enterprise hosts.

## Non-goals

- No simultaneous implementation of GitLab, Bitbucket, or Azure DevOps.
- Known non-GitHub remotes may be detected so users get a clear unsupported
  provider message, but detection is not API/auth support.
- No token in Zustand, localStorage, IPC payloads, logs, crash reports, or
  serialized Tauri state.
- No transparent fallback from one provider to another after a write begins.
- No automatic migration of `gh` credentials into GitLane-owned storage.
- No requirement to cache native API clients or tokens.
- No removal of `gh` until feature parity and migration criteria are met.

## Provider-neutral domain model

### Repository identity

Replace assumptions shaped as only `path + account username` with:

```rust
pub struct GithubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

pub struct GithubAccountRef {
    pub provider: GithubProviderKind,
    pub host: String,
    pub account_id: String,
    pub login: String,
}

pub struct GithubContext {
    pub workdir: String,
    pub repository: GithubRepository,
    pub account: Option<GithubAccountRef>,
}

pub enum GithubProviderKind {
    GhCli,
    Native,
}
```

Semantics:

- `host` is mandatory and normalized without scheme.
- `owner/name` identifies the GitHub repository independently of the local path.
- `account_id` is provider-owned and stable; it is not assumed to equal login.
- `login` is display data and may change.
- `workdir` remains available to `GhProvider`, which resolves repository context
  according to local remotes.
- tokens are deliberately absent.

### Frontend-safe account shape

The TypeScript account model may persist:

```ts
interface GithubAccountRef {
  provider: "gh" | "native";
  host: string;
  accountId: string;
  login: string;
}
```

It must not contain token material, OAuth device codes, refresh tokens, or
keychain identifiers that could be used to retrieve another account's secret.

### Binding migration

Current binding:

```text
repo path → username
```

Target versioned binding:

```json
{
  "version": 2,
  "provider": "gh",
  "host": "github.com",
  "accountId": "alice",
  "login": "alice"
}
```

Migration rules:

1. Treat an existing string binding as `{ provider: "gh", host: "github.com" }`.
2. Resolve it against the loaded `gh` accounts.
3. Write the structured binding only after successful resolution.
4. Preserve unresolved legacy values so a temporarily missing account does not
   silently switch identity.
5. Keep commit identity separate from GitHub authentication identity.

## `GithubProvider` boundary

The provider contract should operate on GitLane domain types, not raw `gh`
JSON, CLI argument vectors, Octocrab models, or HTTP responses.

Illustrative shape:

```rust
#[async_trait::async_trait]
pub trait GithubProvider: Send + Sync {
    fn kind(&self) -> GithubProviderKind;

    async fn accounts(&self) -> Result<Vec<GithubAccount>, GithubError>;
    async fn resolve_repository(
        &self,
        workdir: &str,
        account: Option<&GithubAccountRef>,
    ) -> Result<GithubRepository, GithubError>;

    async fn list_prs(&self, ctx: &GithubContext)
        -> Result<Vec<PullRequestSummary>, GithubError>;
    async fn pr_detail(&self, ctx: &GithubContext, number: u64)
        -> Result<PullRequestDetail, GithubError>;
    async fn pr_checks(&self, ctx: &GithubContext, number: u64)
        -> Result<Vec<PrCheck>, GithubError>;
    async fn pr_diff(&self, ctx: &GithubContext, number: u64)
        -> Result<Vec<FileDiff>, GithubError>;
    async fn review_threads(&self, ctx: &GithubContext, number: u64)
        -> Result<Vec<ReviewThread>, GithubError>;

    async fn merge_pr(&self, ctx: &GithubContext, request: MergePr)
        -> Result<ActionResult, GithubError>;
    async fn comment_pr(&self, ctx: &GithubContext, request: CommentPr)
        -> Result<ActionResult, GithubError>;
    async fn review_pr(&self, ctx: &GithubContext, request: ReviewPr)
        -> Result<ActionResult, GithubError>;
    async fn set_pr_state(&self, ctx: &GithubContext, request: SetPrState)
        -> Result<ActionResult, GithubError>;
    async fn create_pr(&self, ctx: &GithubContext, request: CreatePr)
        -> Result<ActionResult, GithubError>;
    async fn set_thread_resolved(
        &self,
        ctx: &GithubContext,
        request: SetThreadResolved,
    ) -> Result<ActionResult, GithubError>;
}
```

The final trait may be split into smaller capabilities if implementation shows
that one interface is too broad:

```text
GithubIdentityProvider
GithubPullRequestReader
GithubPullRequestWriter
GithubReviewThreadProvider
```

Start with one internal trait only if it remains readable. Avoid speculative
public abstractions.

## Provider service and selection

Add a `GithubService` that:

- resolves the selected provider from `GithubAccountRef.provider`;
- builds `GithubContext`;
- validates repository/account host compatibility;
- calls exactly one provider;
- maps `GithubError` to the existing `Result<T, String>` IPC surface initially;
- never retries a write through another provider;
- exposes provider capabilities to the settings UI.

Provider selection policy:

1. A repository with a saved account binding uses that binding's provider.
2. An unbound repository defaults to an active `gh` account while `gh` remains
   the product default.
3. Native accounts are opt-in and never silently replace a `gh` binding.
4. If the selected provider is unavailable, show a recovery action rather than
   falling back under another identity.

## `GhProvider`

### Responsibilities

- run all GitHub operations through `gh`;
- discover accounts for every configured host;
- resolve tokens only immediately before a command requiring `GH_TOKEN`;
- pass both hostname and username to `gh auth token`;
- preserve `gh pr merge` semantics;
- parse structured JSON only;
- enforce minimum version and capability checks.

### Account discovery

Prefer structured output:

```bash
gh auth status --json hosts
```

instead of parsing human-readable status text when the supported minimum
version guarantees the JSON shape.

Each discovered account must carry:

- host;
- login/account id;
- active state for that host;
- authentication health;
- display name/email resolved through the selected token where available.

### Token policy

- Call `gh auth token --hostname <host> --user <login>`.
- Hold the returned token only in a local variable long enough to populate a
  child process environment.
- Never cache it in a static, Tauri state, provider struct, filesystem, or
  frontend store.
- Never include it in debug formatting or errors.
- Clear ownership promptly by allowing the local `String` to drop; consider a
  secrecy/zeroize wrapper only if it does not complicate process invocation.

### Minimum-supported-`gh` detection

Add a preflight result:

```rust
pub struct GhCapabilities {
    pub version: Version,
    pub auth_status_json: bool,
    pub pr_diff_patch: bool,
    pub graphql: bool,
}
```

Implementation:

1. Run `gh version`.
2. Parse the first semantic version from output such as
   `gh version 2.95.0 (...)`.
3. Compare it with a single documented `MIN_GH_VERSION` constant.
4. Probe essential structured capabilities where version alone is insufficient:
   - `gh auth status --json hosts`;
   - `gh api graphql`;
   - required `gh pr view --json` fields.
5. Cache only the non-secret version/capability result for the process lifetime.
6. Return a typed `UnsupportedVersion` error with installed version, required
   version, and an upgrade URL.

Do not select an arbitrary minimum version. Establish it through a compatibility
matrix against the oldest release that supports:

- `gh auth status --json hosts`;
- multi-account `gh auth token --hostname --user`;
- all current PR JSON fields;
- `gh pr diff --patch --color never`;
- GraphQL execution;
- current PR write commands.

Record the tested minimum in `CLAUDE.md`, README prerequisites, and release
notes. The local development version on June 21, 2026 is `2.95.0`; that is a
development observation, not the minimum.

## Typed errors

Introduce an internal error enum before adding another provider:

```rust
pub enum GithubError {
    ProviderUnavailable { provider: GithubProviderKind },
    UnsupportedVersion { installed: String, required: String },
    NotAuthenticated { host: String, account: Option<String> },
    RepositoryNotFound { workdir: String },
    HostMismatch { repo_host: String, account_host: String },
    PermissionDenied { operation: &'static str },
    RateLimited { reset_at: Option<String> },
    Network(String),
    InvalidResponse(String),
    CommandFailed(String),
}
```

Initially map these to current user-facing strings at the Tauri boundary. Later,
IPC may expose stable error codes while keeping secrets and raw responses
server-side.

## Native authentication provider

### Product decision gate

Start implementation only when at least one requirement is accepted:

- GitLane must work without `gh`;
- onboarding must be fully in-app;
- GitLane must control account switching and reauthentication;
- enterprise customers require provider-native configuration;
- direct API latency/caching materially improves the product.

Before registering credentials, decide between:

- **GitHub OAuth App with Device Flow:** simpler user-token model for a desktop
  client;
- **GitHub App user authorization:** finer permissions and better long-term
  security, but more application and installation semantics.

GitHub currently recommends considering a GitHub App over an OAuth App. Device
Flow itself requires only the app client id during polling; it must be enabled
in the app registration.

### Device Flow

Backend flow:

1. Request device/user codes from
   `POST https://<host>/login/device/code`.
2. Return only the user code, verification URI, expiry, and safe display state
   to the frontend.
3. Open the verification URI in the browser.
4. Poll `POST https://<host>/login/oauth/access_token` no faster than the
   returned interval.
5. Handle:
   - `authorization_pending`;
   - `slow_down` by adding five seconds;
   - `expired_token`;
   - `access_denied`;
   - `device_flow_disabled`.
6. Validate the authenticated identity immediately after receiving a token.
7. Store the token in the OS credential store.
8. Return only account metadata over IPC.

Cancellation must stop polling and discard device codes. Device codes are
short-lived secrets and must not be logged or persisted.

### Secret storage

Requirements:

- Rust-only access.
- macOS Keychain for the first supported platform.
- service name namespaced to GitLane.
- key derived from provider, host, and stable account id.
- atomic add/update/delete.
- no token backup through localStorage or normal app preferences.
- logout deletes the credential and account metadata.
- invalid/revoked credentials produce a reauthenticate action.

Evaluate a small OS-keychain crate or Tauri-compatible secure-storage plugin.
Do not select a dependency until its macOS behavior, maintenance, licensing,
and thread/runtime requirements are verified.

### Native API client

Octocrab is the leading candidate:

- runtime personal/OAuth token clients;
- configurable base URI for enterprise hosts;
- typed pull-request list/detail/create/merge/review/files/diff operations;
- checks and general REST modules;
- low-level REST methods for uncovered endpoints;
- GraphQL support.

Custom code will still be required for:

- provider-neutral DTO mapping;
- review-thread GraphQL query/mutations;
- pagination policy;
- GitLane `FileDiff` conversion;
- merge-queue/auto-merge parity;
- typed error mapping;
- host/account/repository resolution.

Pin an evaluated Octocrab version when implementation starts; do not put
`latest` or a broad unreviewed version range into `Cargo.toml`.

### API compatibility

- Send GitHub's recommended API version header for REST calls.
- Treat GraphQL schemas as versioned build inputs if using generated query
  types.
- Add pagination tests and rate-limit handling.
- Support enterprise base URLs independently for web, REST, GraphQL, and upload
  endpoints.
- Verify custom enterprise certificates/proxies before claiming GHES support.

## Phased roadmap

### Phase 1 — split `github.rs` ✅ done (GL-2)

**Done.** Split the module by responsibility without behavior changes —
`github.rs` is now the `github/` directory (`cli` / `dto` / `prs` / `threads` /
`diff`) with `mod.rs` as a stable re-export facade.

Exit criteria:

- focused modules;
- stable facade;
- transport/parser tests;
- only `cli.rs` launches `gh`.

### Phase 2 — host-aware `GhProvider` groundwork ✅ done

**Done in GL-3.** Account discovery now uses `gh auth status --json hosts`,
account bindings persist `{ provider, host, accountId, login }`, token
resolution passes both `--hostname` and `--user`, and GitHub-backed fetch/push
credential wiring is host-aware.

Changes:

- add `GithubRepository`, `GithubAccountRef`, and `GithubContext`;
- make account discovery host-aware;
- change token resolution to accept host + login;
- migrate path-to-username bindings to versioned structured bindings;
- preserve existing IPC where possible.

Exit criteria:

- two accounts with the same login on different hosts remain distinct;
- repository and account host mismatches fail before an operation;
- no GitHub provider token crosses IPC; any explicit user-entered credential-save flow must be
  handled as a separate, transient OS credential-helper handoff.

### Phase 3 — provider interface behind existing commands ✅ done

**Done in GL-3.** Existing Tauri command names route through
`GithubService`/`GithubProvider`, with `GhProvider` preserving current `gh`
behavior behind the boundary.

GL-3 also adds remote forge detection for Bitbucket, GitLab, Azure DevOps,
Gitea, and Forgejo/Codeberg so non-GitHub repositories fail with an explicit
unsupported-provider message. Full PR/auth providers for those forges remain
future work.

Changes:

- add `GithubProvider` and `GithubService`;
- implement `GhProvider` by delegating to the split modules;
- route existing Tauri GitHub commands through the service;
- keep command names and TS interfaces stable.

Exit criteria:

- frontend behavior is unchanged;
- all GitHub operations run through the provider boundary;
- no provider-specific type appears in stores/features beyond provider/account
  metadata.

### Phase 4 — `gh` preflight and capability UX

**Partially done in GL-3.** The backend now caches a non-secret `gh` 2.95.0
baseline and checks version/help output for account JSON, host/user token
resolution, PR patch, and GraphQL capabilities. Settings recovery UX remains
future work.

Changes:

- add version parsing and capability probes;
- expose non-secret provider health/account metadata through IPC;
- add settings UI for installed/supported version and authentication health;
- provide install, upgrade, login, and reauthenticate actions.

Exit criteria:

- unsupported versions fail before PR loading;
- errors identify the installed and required versions;
- the UI distinguishes missing CLI, outdated CLI, unauthenticated account, and
  permission failure.

### Phase 5 — native-auth spike

Time-boxed investigation:

- register a development OAuth/GitHub App with Device Flow;
- implement device-code request and polling in Rust;
- store one token in macOS Keychain;
- build an Octocrab client from the retrieved token;
- list repositories and PRs from a disposable account;
- execute one REST write and one review-thread GraphQL query;
- document binary-size, dependency, latency, and enterprise implications.

No production account migration in this phase.

Exit criteria:

- security review completed;
- token never reaches frontend/logs;
- cancellation and slow-down behavior verified;
- feasibility report decides proceed/stop.

### Phase 6 — opt-in `NativeGithubProvider`

Changes:

- implement provider parity for reads first;
- expose native account login/logout in settings;
- keep writes disabled until each operation has tested parity;
- add explicit per-repository provider selection;
- add rate-limit and reauthentication UX.

Exit criteria:

- read parity for list/detail/checks/diff/threads;
- no silent fallback;
- provider identity is visible before writes.

### Phase 7 — native write parity

Implement and verify:

- create/comment/review;
- close/reopen/ready;
- resolve/unresolve thread;
- merge strategies;
- delete-branch behavior;
- merge queue and auto-merge behavior.

Exit criteria:

- disposable-repository integration suite passes for both providers;
- confirmation and refresh behavior is identical at the frontend;
- action results do not falsely report an immediate merge when GitHub queued or
  enabled auto-merge.

### Phase 8 — reassess the default

Do not remove `gh` automatically. Decide using:

- native-provider adoption;
- support burden;
- enterprise compatibility;
- feature parity;
- binary size and update risk;
- authentication failure rates;
- user preference.

Possible outcomes:

- keep `gh` default and native optional;
- make native default and `gh` advanced/fallback;
- retain only one provider in a future major release.

## Testing strategy

Unit:

- structured account-binding migration;
- host normalization and mismatch detection;
- semantic version parsing/comparison;
- capability-result mapping;
- typed error mapping;
- Device Flow polling state machine;
- provider-neutral DTO conversions.

Provider contract:

- shared behavior tests executed against fake providers;
- no operation is retried through another provider;
- account/repository context is passed unchanged;
- write results distinguish completed, queued, and auto-merge-enabled states.

`GhProvider` integration:

- subprocess fixture or fake executable records argument/env construction;
- tokens are redacted;
- minimum-version failure;
- multiple hosts/accounts;
- missing/invalid authentication.

Native integration:

- mock HTTP server for REST/GraphQL and Device Flow;
- pagination and rate limits;
- revoked/expired token;
- enterprise base paths;
- malformed and partial GraphQL responses.

Manual:

- multiple GitHub.com accounts;
- GitHub Enterprise account;
- SSO-protected organization;
- provider switch per repository;
- logout/relogin;
- merge queue repository;
- macOS Keychain read/write/delete.

## Documentation updates

When Phase 2 or later lands, update:

- `README.md`;
- `CLAUDE.md`;
- `docs/rules/architecture-rules.md`;
- `docs/rules/architecture-rules-rust.md`;
- privacy/security documentation;
- release notes and prerequisites.

Architecture rules must state:

- providers own GitHub transport and authentication;
- secrets never cross IPC;
- `GhProvider` subprocesses stay off the main thread;
- native HTTP remains async and does not use the blocking subprocess wrapper;
- writes never silently change provider or identity.

## Security checklist

- [ ] Tokens never cross IPC.
- [ ] Tokens/device codes never enter logs or errors.
- [ ] Provider/account/host identity is explicit before writes.
- [ ] Native tokens are stored only in OS secure storage.
- [ ] OAuth polling obeys interval and `slow_down`.
- [ ] Login validates the returned user identity.
- [ ] Logout deletes the secret.
- [ ] Revoked tokens produce reauthentication, not repeated retries.
- [ ] Repository/account host mismatch blocks the operation.
- [ ] No write falls back to another provider.
- [ ] Required scopes/permissions are documented and minimized.
- [ ] GitHub Enterprise certificate/proxy behavior is tested before support is
      advertised.

## References

- [GitHub OAuth and Device Flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)
- [GitHub CLI authentication token command](https://cli.github.com/manual/gh_auth_token)
- [GitHub CLI authentication status command](https://cli.github.com/manual/gh_auth_status)
- [GitHub REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [Octocrab documentation](https://docs.rs/octocrab/latest/octocrab/)
