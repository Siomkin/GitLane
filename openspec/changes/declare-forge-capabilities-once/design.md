# Design

## Context

See proposal.md (Why). The per-finding evidence (`path:line`, the drifted copy, and each
consumer) is under **Findings**. The engine does not change. PR operations still go
through the `forge::context()` provider, and detection stays pure libgit2
(`git/forge/resolution.rs`).

## Goals / Non-Goals

**Goals:** one Rust declaration per forge (identity, capabilities, auth hint), one
frontend presentation table, and no hand-kept forge lists outside those two.

**Non-Goals:** REST transport dedupe, codegen, and new forges (see proposal).

## Decisions

1. **Where capabilities live: the backend.** Add
   `ForgeCapabilities { create, merge_methods: &'static [MergeMethod], state_actions, delete_branch, stacks }`
   to `ForgeIdentity`, filled in by each adapter next to `pr_noun`. `MergeMethod` and
   `PrStateAction` are the enums from `type-the-ipc-and-write-boundary`, which lands
   first. Serialize it on
   `RepoForge.capabilities: Option<ForgeCapabilities>`, which is `None` for an
   unclassified forge. The frontend keeps its rule that an unknown forge counts as capable
   until detection finishes.
   *Alternative considered:* a frontend-only `FORGES` table (audit A4-6). It is smaller,
   but it keeps the Rust adapters and the UI as two sources that must agree, and a
   frontend miss becomes a silent no-op write (Origin's ignored `delete_branch`, A2-7).
   Rejected as the source of truth. The frontend table stays, but only for presentation
   (label, noun, icon).
2. **One provider enum.** `ForgeKind` absorbs `ForgeProvider` (`git/types/auth.rs`),
   including its `Other` variant, and exposes one `key()`. `PROVIDERS`, the OAuth
   `ProviderConfig` table (A2-11: one `match` that returns endpoints, client-id env and user
   parser) and the keychain namespace all key off it. Wire strings stay byte-identical, so
   stored bindings and keychain entries still resolve.
3. **Auth errors.** `GithubError::NotAuthenticated { host, account, hint }`, where `hint`
   comes from the provider's `ForgeIdentity`. `from_command` takes the resolved `host` from
   the context. `map_glab_error` classifies its own "not logged in" text. GitLab, Bitbucket
   and Origin return `NotAuthenticated` instead of the `CommandFailed` workaround, so
   `CommandErrorKind::Auth` flows through unchanged.
4. **Subprocess boundary.** `auth_providers` calls `gitlab::transport::run_glab` and
   `origin::command::run_origin` (made `pub(crate)`), and the duplicate `GitlabUser`
   parser is removed. `probe.rs` keeps `az` and `tea` only, on `bounded_output::capture`.
5. **Frontend derivation.** `forgeHelp.ts`'s `PULL_REQUEST_PROVIDERS`,
   `CREATE_PULL_REQUEST_PROVIDERS`, the `BranchContextMenu` literal, `pulls/list.ts`,
   `PrActions` flags, the Remotes legend and the Accounts chip all read
   `repo.forge.capabilities` or `FORGES[kind]`. The eight brand/label tables (A8-6) and the
   four popover builders (A8-7) collapse into `FORGES` plus one
   `prForgeModel(forge, spec)`. `pulls/list.ts` and `BranchContextMenu` reuse
   `supportsPullRequests` until the capability record lands, which fixes the Origin P0
   early (task 1.1).
6. **Commit links.** `lib/prs.ts` builds `PrCommitView.url` with
   `forgeUrls.commitWebUrl(forge, oid)` and deletes the GitHub-only `commitUrl`.

**IPC four layers (RepoForge):** impl `git/forge/resolution.rs` (summary) → command
`commands/repo.rs` (unchanged signature) → type `git/types/repo.rs` (+
`ForgeCapabilities`, re-exported flat) → TS `src/lib/api/git/repo.ts` interface and zod
schema.

Stores: `repo` (holds `forge`) and `pulls` (list gate). No new store. `forgeHelp.ts` and
the settings folders are in the size look band, so run `bun run sizes` after the collapse.

## Risks / Trade-offs

- [Folding `ForgeProvider` into `ForgeKind` changes stored binding keys] → Keep the exact
  wire strings via `key()`/serde renames, and add a round-trip test for every stored key.
- [The capability record drifts from adapter overrides] → Add a dispatch test that
  asserts, for each provider, that a capability marked false is exactly an adapter method
  that returns the refusal default.
- [A bigger diff in chrome settings] → Land it in the task order below. The Origin P0 fix
  comes first as a one-line predicate swap.

## Findings

### A2-2 — `GithubError::from_command` hard-codes github.com and `gh auth login`, and the glab CLI path goes through it too
- Priority: P1
- Smell: Switch Statements on error text / sibling providers disagreeing
- Where: src-tauri/src/git/forge/domain.rs:97-137 (the `NotAuthenticated { host: DEFAULT_GITHUB_HOST, account: None }` arm is at :105-113), domain.rs:155-158; callers src-tauri/src/git/forge/gh_provider.rs:93-96 (and every other `from_command` map in that file), src-tauri/src/git/forge/gitlab/transport.rs:231-236
- Evidence: any error text containing "not logged in", "authentication", "bad credentials" or "gh auth login" becomes `NotAuthenticated { host: "github.com", account: None }`. The message then says "No authenticated GitHub account is available for github.com. Run `gh auth login --hostname github.com`." (a) GHES: a bound account whose token was revoked gives gh `HTTP 401: Bad credentials (https://ghe.example.test/api/graphql)`. `list_prs` maps that through `from_command`, so the user is sent to github.com, and the bound login is dropped. `token_for_context` (gh_provider.rs:26-33) fixes the host only for the token-lookup step. (b) GitLab over glab: `map_glab_error` keeps only the "glab) not found" case and sends the rest to the same classifier. So a glab failure whose text contains "not logged in" ("You are not logged into any GitLab hosts…") or "authentication" becomes gh advice pointing at github.com for a GitLab repo. The GitLab tests (gitlab/transport/tests.rs:145-150) cover only the REST 401 path. They do not cover the glab CLI path.
- Consequence: the user is told to sign in with the wrong CLI on the wrong host. Because the variant maps to `CommandErrorKind::Auth` (types/error.rs:192), the "Fix authentication…" toast action also appears for the GitLab case.
- Fix: Replace Parameter with Explicit Methods. `from_command` should take the resolved `host` (and account login) from `GithubContext`, not assume `DEFAULT_GITHUB_HOST`. `map_glab_error` should classify its own auth text into a GitLab-worded error (see #3) and not reuse the gh classifier.
- Confidence: high for the code path and the GHES case. Medium on the exact glab wording.

### A2-3 — Auth failures from GitLab, Bitbucket and Origin lose the `auth` category because `NotAuthenticated` is gh-worded
- Priority: P2
- Smell: Refused Bequest (a shared error enum whose user-facing text fits only one implementer)
- Where: src-tauri/src/git/forge/domain.rs:55-58, :155-158; src-tauri/src/git/forge/gitlab/mod.rs:71, :185-189; src-tauri/src/git/forge/gitlab/transport.rs:302; src-tauri/src/git/forge/bitbucket/mod.rs:55, :59, :174-178; src-tauri/src/git/forge/bitbucket/transport.rs:135; src-tauri/src/git/forge/origin/ops.rs:171
- Evidence: the `NotAuthenticated` text is fixed to "GitHub account … Run `gh auth login`". So every non-gh provider deliberately returns `GithubError::CommandFailed(...)` for "no sign-in" or HTTP 401 (see the comments "used instead of the gh-worded NotAuthenticated" at gitlab/mod.rs:184 and bitbucket/mod.rs:171). Origin maps every CLI failure to `CommandFailed` (ops.rs:171). `CommandFailed` maps to `CommandErrorKind::Forge`/`commandFailed` (types/error.rs:198), and the frontend adds "Fix authentication…" only when `kind === "auth"` (src/store/ui/toasts.ts:44).
- Consequence: a GitLab or Bitbucket REST 401, or a missing Bitbucket token, shows a plain error with no path to Settings → Accounts. GitHub gets that action. Adding a provider repeats the workaround.
- Fix: Introduce Parameter Object. Have `NotAuthenticated` carry a provider-supplied hint (or the provider's `ForgeIdentity`), so `to_ipc_string` words it per forge. Then GitLab, Bitbucket and Origin can return the `auth` category without the gh text.
- Confidence: high

### A2-4 — Stale user-facing copy says Origin PR creation is missing and leaves Origin out of the supported-forge list
- Priority: P1
- Smell: misleading Comments / Divergent Change (capability copy kept apart from the implementation)
- Where: src-tauri/src/auth_providers/spec.rs:50; src-tauri/src/git/forge/domain.rs:153; src-tauri/src/git/forge/origin/mod.rs:51
- Evidence: spec.rs:50 notes: "…Creating Origin PRs is not in GitLane yet." That text is shown in Settings (src/components/chrome/settings/accounts-panel/provider-connect/ForgeConnect.tsx:254). But `OriginProvider::create_pr` exists (origin/mod.rs:118 → origin/ops.rs:287), the frontend enables it (`supportsCreatingPullRequests("cursor-origin") === true`, src/lib/forgeHelp.test.ts:88), and the archived change `2026-08-20-enable-origin-pr-create-and-lifecycle` shipped it. `UnsupportedForge` (domain.rs:153) says "GitLane supports GitHub pull requests, GitLab merge requests, and Bitbucket pull requests" and omits Cursor Origin. On Origin, a malformed path raises `RepositoryNotFound` (origin/mod.rs:51), whose text (domain.rs:159-161) says "Could not resolve a GitHub repository … has a GitHub remote". Out of slice, but the same drift: src/features/pull-requests/LeftPanel.tsx:89-90 has a "Creating Cursor Origin pull requests isn't available" tooltip branch.
- Consequence: Settings tells Origin users a working feature is missing. An Azure, Gitea or Forgejo user gets an incomplete list of supported forges. An Origin user is told to add a GitHub remote.
- Fix: Substitute Algorithm. Build the `UnsupportedForge` list from the provider table (`provider_for` in service.rs) and not a literal. Remove the stale sentence in spec.rs:50. Have Origin return its own "Could not resolve a Cursor Origin repository" `CommandFailed`, which it already uses at origin/mod.rs:43-46.
- Confidence: high

### A2-6 — A forge's identity is spelled three ways, so adding a provider means shotgun surgery
- Priority: P2
- Smell: Shotgun Surgery / Parallel Inheritance Hierarchies
- Where: src-tauri/src/git/forge.rs:138-192 (`ForgeKind` + `label` + `key`); src-tauri/src/git/types/auth.rs:26-56 (`ForgeProvider` + `as_wire_str`: no CursorOrigin, adds `Other`); bare `&str` matches at src-tauri/src/git/oauth/config.rs:47, :80, :109, src-tauri/src/git/oauth/identity.rs:58, src-tauri/src/auth_providers/status.rs:72-88, src-tauri/src/auth_providers/spec.rs:28/54/67/83/96; constants src-tauri/src/git/forge/gitlab/mod.rs:41, src-tauri/src/git/forge/bitbucket/mod.rs:41; GitHub is `"gh"` in src-tauri/src/git/forge/domain.rs:10 and `ForgeIdentity.key`, `"github"` in both enums, and a literal `"gh"` again at src-tauri/src/git/transport_auth.rs:120
- Evidence: one forge needs edits in `parsing.rs::classify_host` (:310), `ForgeKind` label/key, `service.rs::provider_for` (:234), a new `resolution.rs` walker (see #13), `auth_providers/spec.rs`, `status.rs::fetch_account`, `ForgeProvider`, the oauth `config.rs` matches, and the frontend lists. Drift has already happened: `service.rs:28` documents keys "`gh` / `gitlab` / `bitbucket`" and omits `cursor-origin`. `status.rs:67-70` says the whoami set "must stay in sync with `FORGE_WHOAMI` in `src/store/accounts.ts`", but that set is `FORGE_WHOAMI_PROVIDERS` in src/lib/forgeHelp.ts:22.
- Consequence: forgetting any one site gives a half-supported forge (listed in Settings but not routed, or routed with the wrong keychain namespace). The stale comment sends a maintainer to a file without the list.
- Fix: Replace Type Code with Class. Make `ForgeKind` the single provider enum (fold in `ForgeProvider`, keep one `key()`), and key `PROVIDERS`, the oauth config and the keychain namespace off it. Fix the comment to point at src/lib/forgeHelp.ts.
- Confidence: high

### A2-7 — The frontend keeps provider capability allow-lists because the backend never declares capabilities
- Priority: P2
- Smell: Parallel Inheritance Hierarchies / Shotgun Surgery
- Where: src-tauri/src/git/forge/service.rs:27-37 (`ForgeIdentity` holds only `key` and `pr_noun`), :80-173 (capabilities exist only as trait defaults that refuse); out of slice: src/features/pull-requests/PrActions.tsx:23-29 (`basicMerge`, `canManageState`, `allowDeleteBranch={!isOrigin}`), src/lib/forgeHelp.ts (`supportsCreatingPullRequests`, `supportsPullRequestsViaForgeAuth`)
- Evidence: whether a provider supports rebase-merge, delete-branch, close/reopen, stacks or creation lives in each Rust adapter's defaults and overrides. The frontend repeats it as hard-coded `ForgeKind` checks. Origin silently ignores `delete_branch` (origin/ops.rs:305), which is safe only because PrActions.tsx:46 hides the checkbox for Origin.
- Consequence: a capability change touches the Rust adapter plus 2–3 frontend files, and a frontend miss turns into a silent no-op write. #4 shows the copy has already drifted.
- Fix: Extract Class. Add a `capabilities` field to `ForgeIdentity` (rebase_merge, delete_branch, state_actions, stacks, create), return it with the repo forge summary, and replace the frontend `ForgeKind` checks with it.
- Confidence: medium (touches the IPC contract, so it needs a design call)

### A2-8 — auth_providers spawns glab and origin outside their single subprocess sites
- Priority: P2
- Smell: Divergent Change / broken boundary rule
- Where: src-tauri/src/auth_providers/probe.rs:13-22, :47-59, :61-86; src-tauri/src/auth_providers/spec.rs:31/44 (`glab auth status`, `origin auth status`) and :34/:47 (logout); duplicate whoami parser src-tauri/src/auth_providers/status.rs:91-109 vs src-tauri/src/git/oauth/identity.rs:65-83
- Evidence: docs/rules/architecture-rules-rust.md §1 says "`src-tauri/src/git/forge/origin/command.rs` is the only place that constructs an `origin` subprocess" and "Provider CLI output is hard-bounded while it is read". `probe_cmd` does `Command::new(cli)` for glab, origin, az and tea. It never calls `crate::git::clear_repository_local_env` (which gh, glab and origin all do: cli/command.rs:24, gitlab/transport.rs:87, origin/command.rs:18). It skips Origin's Windows refusal and `NO_COLOR`. It waits by polling `try_wait` without draining the pipes, then calls `wait_with_output` with no byte cap. So `origin auth status` runs through two different subprocess sites (`origin::account::current_account` via `run_origin`, and `probe_cli`) with different env and bounds. `glab api user` JSON is parsed by two separate `GitlabUser` structs.
- Consequence: a fix to one subprocess site (env scrubbing, output bounds, probe-cache invalidation on NotFound) does not reach the Settings probes. A chatty CLI that fills the pipe before exit hits the 4 s timeout and shows as "unverified".
- Fix: Move Method. Route glab and origin status/logout through `gitlab::transport::run_glab` and `origin::command::run_origin` (exposed `pub(crate)` like `origin_account`). Keep `probe.rs` only for az and tea, using the shared `bounded_output::capture`.
- Confidence: high

### A2-11 — OAuth provider config is spread across four string `match`es
- Priority: P2
- Smell: Switch Statements
- Where: src-tauri/src/git/oauth/config.rs:46-66, :76-97, :108-115; src-tauri/src/git/oauth/identity.rs:58-62
- Evidence: `provider_config`, `endpoints`, `builtin_client_id` and `resolve_account` each `match provider { "gitlab" => …, "bitbucket" => … }`. `ProviderConfig` already exists but carries only `flow`, `scopes` and `transport_username`.
- Consequence: a third OAuth provider needs 4 coordinated edits in 2 files. Missing one gives a config that passes `is_supported` but fails later with "Unsupported provider for identity resolution".
- Fix: Replace Conditional with Polymorphism (a data table). Put `endpoints: fn(&str) -> Option<Endpoints>`, `client_id_env: Option<&str>` and `parse_user: fn(&str) -> Result<ResolvedAccount, String>` on `ProviderConfig`, and keep one `match` in `provider_config`.
- Confidence: high

### A4-3 — PR commit links derived by a GitHub-only URL heuristic; GitLab/Bitbucket rows lose the link
- Priority: P2 (inconsistent)
- Smell: Duplicate Code (a second, weaker copy of `commitWebUrl`)
- Where: src/lib/prs.ts:211-218,236,300; src/lib/forgeUrls.ts:36-54; src/features/pull-requests/PrCommitsTab.tsx:154-163; src-tauri/src/git/forge/gitlab/dto.rs:358,374; src-tauri/src/git/forge/bitbucket/dto.rs:393,406
- Evidence: `commitUrl(prUrl, oid)` swaps `/pull/<n>` for `/commit/<oid>` and returns `""` otherwise. GitLab MR urls are `…/-/merge_requests/7` (gitlab/dto.rs fixture) and Bitbucket's are `…/pull-requests/7` (bitbucket/dto.rs fixture), neither containing `/pull/`, so `PrCommitView.url` is `""` and `PrCommitsTab` hides the "Open commit on GitLab/Bitbucket" button. `forgeUrls.commitWebUrl(forge, sha)` already builds the right per-forge commit URL (`/-/commit/`, `/commits/`) from `RepoForge.webUrl`.
- Consequence: the commit-open affordance silently exists only on GitHub/Origin; any future forge URL change must be made in two places.
- Fix: Substitute Algorithm — build `PrCommitView.url` with `commitWebUrl(forge, oid)` (pass the repo forge into `detailToPr`/`uiCommits`, or resolve at render in `CommitRow`), and delete `commitUrl`.
- Confidence: high

### A4-6 — Forge identity is five parallel string vocabularies plus per-forge `if`/`switch` chains
- Priority: P2 (costly to change)
- Smell: Shotgun Surgery / Primitive Obsession / Switch Statements
- Where: src/lib/api/git/types/repo.ts:140-149 (`ForgeKind`); src/lib/api/providers.ts:17-23 + src/lib/api/schemas/providers.ts:20-27 (`ForgeAuthProvider`, spelled out twice); src/lib/api/git/types/auth.ts:13-20 (`GitTransportProvider`); src/lib/remotes.ts:11-19 (`RemoteProvider`, Azure spelled `"azure"`), 79-116 (three mapping functions), 353-373 (`providerSupportsPrs` middle man, `prNoun`, `prAbbr`, `PROVIDER_LABEL`); src/lib/forgeHelp.ts:9 (`PullRequestProvider`), 12-51 (capability sets), 67-69 (`pullRequestLabel`); src/lib/gitError.ts:235-255 (`CREDENTIAL_PROVIDER_NAME` ≈ `PROVIDER_LABEL`, differing only in "Azure Repos"/"Azure DevOps", "Git"/"This host"); src/features/pull-requests/prForgeOpen.tsx:12-42 (name, icon, `requestNoun`); src/features/pull-requests/PrActions.tsx:23-31 (`basicMerge`, `canManageState` allow-list)
- Evidence: the same forge set is typed five ways and translated by `forgeAuthProviderFor`, `transportProviderForRemoteProvider`, `transportProviderForForgeAuth`; the GitLab "MR" noun is decided in three places (`prNoun`/`prAbbr`, `pullRequestLabel`, `prForgeOpen.requestNoun`); what a forge can do (rebase-merge, close/reopen, delete-branch, create, whoami, CLI sign-out) is spread across `PrActions.tsx`, `PrMergeMenu`'s `basic` flag and eight `forgeHelp` sets. Most predicates take `string`, so passing the wrong vocabulary (`"azure"` vs `"azure-devops"`) compiles and silently answers `false`.
- Consequence: adding or changing one forge (e.g. GitLab gaining close/reopen) touches ~12 named places across `lib/api`, `lib`, and `features/pull-requests`, with no compiler help for the string-typed ones.
- Fix: Replace Type Code with Class — one `FORGES: Record<ForgeKind, {label, requestNoun, abbr, capabilities…}>` descriptor in `lib`, keyed by `ForgeKind`, from which `forgeHelp`'s sets, `PROVIDER_LABEL`/`CREDENTIAL_PROVIDER_NAME`, `prNoun`, `pullRequestLabel`, and `PrActions`' flags are derived; tighten the predicates' parameter type to `ForgeKind`. Scope: this collapses the *frontend* duplication (labels, nouns, capability sets, `PrActions` flags); `ForgeAuthProvider` and `GitTransportProvider` mirror Rust enums on the wire and stay as mirrors. (Distinct from the tracked forge REST transport dedupe.)
- Confidence: medium

### A7-3 — Hard-coded "PR-capable forge" list duplicates `supportsPullRequests`; a sibling copy already drifted
- Priority: P1 (misleading, will be got wrong)
- Smell: Switch Statements / Shotgun Surgery (hard-coded list of built-in variants)
- Where: src/store/pulls/list.ts:77-83; existing predicate src/lib/forgeHelp.ts:28,53 (`PULL_REQUEST_PROVIDERS` / `supportsPullRequests`); drifted copy (slice 8's file) src/components/chrome/overlays/menus/BranchContextMenu.tsx:37-43 → quickActions.tsx:112-122
- Evidence: the store gates PR loading on `forge.kind !== GitHub && !== GitLab && !== Bitbucket && !== CursorOrigin`. The menu's copy — whose comment claims it is "matching the PR list's own gate" — omits `CursorOrigin`, so "Open a pull request…" is hidden for Cursor Origin repos although `CREATE_PULL_REQUEST_PROVIDERS` includes it and the PR list works. `ForgeKind` values are the same strings the predicate takes (`"github"`, `"cursor-origin"`, …).
- Consequence: wrong result today for Origin repos; the next provider needs 3+ list edits that nothing checks.
- Fix: Replace Conditional with the existing predicate — `forge && !supportsPullRequests(forge.kind)` in pulls/list.ts and in the menu.
- Confidence: high

### A7-12 — Forge-auth provider enum duplicated in the storage layer
- Priority: P3 (duplication)
- Smell: Duplicate Code / hard-coded list of variants
- Where: src/store/accountsStorage.ts:62-69; source src/lib/api/schemas/providers.ts:20-27 (module-private, pinned to the TS type via `assertEqual`)
- Evidence: both declare `z.enum(["gitlab","bitbucket","azure-devops","gitea","forgejo","cursor-origin"])`. The storage copy has no type pin and its schemas are `strictObject`, so a provider added to `ForgeAuthProvider` + the IPC schema but not here makes `readProviderTokens`/`readForgeCredentials` silently drop that provider's stored metadata on every read (user appears signed out after reload).
- Consequence: one more place to remember per provider, failing silently.
- Fix: Export the IPC `forgeAuthProviderSchema` and import it.
- Confidence: high

### A8-2 — Branch menu hides "Open a pull request…" on Cursor Origin repos
- Priority: P0 (broken today)
- Smell: Switch Statements / hard-coded list of built-in variants duplicating `CREATE_PULL_REQUEST_PROVIDERS`
- Where: src/components/chrome/overlays/menus/BranchContextMenu.tsx:39-43, src/components/chrome/overlays/menus/branch-context-menu/quickActions.tsx:116-122 (vs src/lib/forgeHelp.ts:31-36, src/components/chrome/action-bar/actionBarModel.ts:56-58)
- Evidence: `prsUnsupported = forge != null && forge.kind !== GitHub && !== GitLab && !== Bitbucket`. `ForgeKind.CursorOrigin` is not in the list, so for an Origin repo `prsUnsupported === true` and quickActions skips the "Open a pull request…" row. `CREATE_PULL_REQUEST_PROVIDERS` (forgeHelp) includes Cursor Origin (archived change `enable-origin-pr-create-and-lifecycle`), and `canCreatePullRequest` / LeftPanel already offer create for Origin.
- Consequence: A shipped capability is unreachable from the branch context menu for one provider; adding the next PR provider needs this hand-edit again.
- Fix: Replace the inline list with `const prsUnsupported = forge?.kind != null && !supportsCreatingPullRequests(forge.kind)` (keeping the "unknown forge counts as capable" rule).
- Confidence: high

### A8-3 — Remotes panel legend says Bitbucket has no PR features; rows say the opposite
- Priority: P1 (misleading)
- Smell: Comments/static copy gone stale; Duplicate Code (hand-maintained capability list)
- Where: src/components/chrome/repo-settings/remotes-panel/PrAvailabilityLegend.tsx:3-16, src/components/chrome/repo-settings/remotes-panel/RemoteRow.tsx:47,98-106, src/components/chrome/repo-settings/remotes-panel/RemoteSummaryCard.tsx:22
- Evidence: Legend row `{ label: "Bitbucket · Azure · Gitea", note: "…PR features are unavailable." }` and no Cursor Origin row. Directly above it, a Bitbucket `RemoteRow` computes `prs = providerSupportsPrs("bitbucket") === true` (lib/remotes.ts:353 → `supportsPullRequests`) and renders the green "PR remote"/"PRs on" chip; RemoteSummaryCard shows "Pull requests enabled".
- Consequence: The same page contradicts itself for Bitbucket (GL-141 shipped PRs) and omits Origin entirely; the legend will drift again on the next provider.
- Fix: Replace Magic Literal with derived data — build the legend rows from `PULL_REQUEST_PROVIDERS` / `providerLabel`, or at minimum move Bitbucket into a PR-capable row and add Cursor Origin.
- Confidence: high

### A8-4 — Connected GitLab/Cursor Origin CLI accounts are labelled "Sign-in only" under a "Merge requests" section chip
- Priority: P1 (misleading)
- Smell: Stale Comment + sibling implementations that disagree
- Where: src/components/chrome/settings/accounts-panel/ConnectedForgeCard.tsx:1-4,58-60, src/components/chrome/settings/accounts-panel/AccountsPanel.tsx:145-151
- Evidence: AccountsPanel's section capability for GitLab/Origin is `pullRequestLabel(provider)` with tone `pr` when `supportsPullRequestsViaForgeAuth(provider) && forges.length > 0` (a glab / origin sign-in). The row rendered for that very `forges` entry is `ConnectedForgeCard`, which unconditionally prints the "Sign-in only" chip, and its header comment still says CLI sign-ins are "plainly auth-only and PR-less".
- Consequence: A user signed in with glab sees "Merge requests" on the GitLab header and "Sign-in only" on the account that enables it.
- Fix: Replace Conditional with the shared predicate — show the chip only when `!supportsPullRequestsViaForgeAuth(status.provider)` and update the header comment.
- Confidence: high

### A8-6 — Per-forge presentation is re-declared in ~8 places, already drifting
- Priority: P2 (costly to change)
- Smell: Shotgun Surgery / Switch Statements on `ForgeKind` / provider string
- Where: brand icon — src/components/chrome/action-bar/provider-indicator/ProviderIndicator.tsx:29-37 (`FORGE_ICON`), src/components/chrome/action-bar/provider-indicator/model.ts:21-29 (`FORGE_ICON_KEY`) + ProviderPopover.tsx:32-53, src/components/chrome/IdentityChip.tsx:65-99,185-208, src/components/chrome/repo-settings/remotes-panel/RemoteRow.tsx:44-46,70-78, src/components/chrome/repo-settings/remotes-panel/RemoteSummaryCard.tsx:18-21,45-55, src/components/chrome/settings/accounts-panel/ProviderSection.tsx:13-19 (`META`), src/components/chrome/overlays/provider-oauth/ProviderOauthDialog.tsx:29-32 (`FORGE`); request noun — src/lib/forgeHelp.ts:67 `pullRequestLabel`, src/lib/remotes.ts:358-360 `prNoun/prAbbr`, RemoteSummaryCard.tsx:28-29, RemoteRow.tsx:99-105, IdentityChip.tsx:73-99
- Evidence: Each site keeps its own `isGithub/isGitlab/isOrigin…` chain or map. Drift already visible: RemoteRow has no Bitbucket branch, so a Bitbucket remote row shows the generic `CloudIcon` while RemoteSummaryCard (same page) shows `BitbucketIcon`; the MR/PR noun is hard-coded in three components although `prNoun`/`pullRequestLabel` exist.
- Consequence: Adding a forge (Origin was the last) requires editing every list above; missing one produces silent wrong icons/copy, as RemoteRow shows.
- Fix: Replace Type Code with a single lookup table — one `FORGE_BRAND: Record<ForgeKind, { name, Icon }>` next to the icons (components/ui) and route nouns through `pullRequestLabel`/`prNoun`; components index it instead of branching.
- Confidence: high

### A8-7 — Provider popover model: four near-identical builders plus three forge `if` chains
- Priority: P2 (costly to change)
- Smell: Duplicate Code / Switch Statements
- Where: src/components/chrome/action-bar/provider-indicator/model.ts:63-107 (github), 127-173 (gitlab), 193-239 (bitbucket), 253-299 (origin), 379-394 (`providerPopoverModel` chains); src/components/chrome/action-bar/provider-indicator/state.ts:53-71; src/components/chrome/action-bar/provider-indicator/popoverTypes.ts:75-77
- Evidence: `githubModel/gitlabModel/bitbucketModel/originModel` share the same `base` shape, the identical `connected` block (only "PR"/"MR" wording differs), the same `transport-auth` shape, and only differ in host default, links, and copy strings. `providerPopoverModel` then repeats the same `GitLab → Bitbucket → Origin → GitHub` chain for three states. The model's fields are still named `githubEyebrow`/`githubLinks` though every forge fills them.
- Consequence: A new PR forge means a ~45-line builder copy plus three chain edits plus a `state.ts` branch; misnamed fields invite GitHub-only assumptions.
- Fix: Parameterize Method — one `prForgeModel(forge, prCount, variant, spec)` where `spec` (per-forge table) carries default host, noun, links, and the three notes; dispatch via `spec = PR_FORGE_SPEC[forge.kind]`; Rename Field `githubEyebrow/githubLinks` → `hostEyebrow/hostLinks`.
- Confidence: high
