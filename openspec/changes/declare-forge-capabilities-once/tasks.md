# Tasks

## 1. Stop the visible drift first

- [x] 1.1 Replace the inline forge list in `components/chrome/overlays/menus/BranchContextMenu.tsx` and `store/pulls/list.ts` with `supportsCreatingPullRequests` / `supportsPullRequests` from `lib/forgeHelp.ts`, keeping "unknown forge counts as capable"; verify with a menu test that "Open a pull request…" appears for `ForgeKind.CursorOrigin`.
- [x] 1.2 Remove the stale "Creating Origin PRs is not in GitLane yet" note (`auth_providers/spec.rs`), the stale Origin tooltip branch in `features/pull-requests/LeftPanel.tsx`, and build `UnsupportedForge`'s supported list from `service.rs::provider_for`; verify with a test asserting that the message names all four PR forges.
- [x] 1.3 Fix the Remotes legend (`repo-settings` remotes panel) and the Accounts "Sign-in only" chip to use `PULL_REQUEST_PROVIDERS` / `supportsPullRequestsViaForgeAuth`; verify with render tests for Bitbucket (legend) and a signed-in glab account (no chip).

## 2. One Rust provider enum (A2-6, A2-11)

- [x] 2.1 Fold `ForgeProvider` (`git/types/auth.rs`) into `ForgeKind` (`git/forge.rs`) with one `key()` and unchanged serde strings; verify with a round-trip test over every existing wire value.
- [x] 2.2 Turn `git/oauth/config.rs` and `identity.rs` into one `ProviderConfig` table keyed by `ForgeKind` (endpoints, client-id env, user parser); verify with `cargo test oauth`.

## 3. Capabilities across IPC (A2-7)

- [x] 3.1 Add `ForgeCapabilities` to `ForgeIdentity` in `git/forge/service.rs`, filled per adapter; verify with a dispatch test that each `false` capability matches an adapter method returning the refusal default.
- [x] 3.2 Add `capabilities: Option<ForgeCapabilities>` to `RepoForge` (`git/types/repo.rs`), fill it in the summary, and mirror it in `src/lib/api/git/repo.ts` (interface + zod schema); verify with `cargo test` and `bunx tsc --noEmit`.
- [x] 3.3 Derive `PrActions.tsx` flags, `forgeHelp.ts` PR predicates and `LeftPanel` gates from `repo.forge.capabilities`, and delete the literal sets they replace; verify that `bun run test` passes with the updated `forgeHelp.test.ts`.

## 4. Presentation table (A4-6, A8-6, A8-7, A7-12, A4-3)

- [x] 4.1 Add `FORGES: Record<ForgeKind, {label, noun, Icon}>` beside the icons in `components/ui`, and replace the per-forge label/icon tables and the four provider-popover builders with it plus one `prForgeModel`; verify with the existing popover and settings render tests.
- [x] 4.2 Import the IPC `forgeAuthProviderSchema` in the storage layer instead of the duplicate enum (A7-12); verify with `bunx tsc --noEmit`.
- [x] 4.3 Build `PrCommitView.url` with `commitWebUrl(forge, oid)` in `lib/prs.ts` and delete `commitUrl`; verify with a test that GitLab and Bitbucket commit rows get links.

## 5. Provider-aware auth errors and subprocess sites (A2-2, A2-3, A2-8)

- [x] 5.1 Give `GithubError::NotAuthenticated` a host from the context and a provider hint, pass the host into `from_command`, and classify glab auth text in `map_glab_error`; verify with tests for the GHES 401, the glab "not logged into" text, and a Bitbucket 401 → `kind: "auth"`.
- [x] 5.2 Route `auth_providers` glab/origin status and logout through `run_glab` / `run_origin`, delete the duplicate `GitlabUser` parser, and move `probe.rs` onto `bounded_output::capture`; verify with `cargo test auth_providers` and a `rg 'Command::new\("(glab|origin)"'` that finds only the two boundary files.
- [x] 5.3 Update `docs/rules/architecture-rules-rust.md` §1 if the probe wording changes, and fix the stale `FORGE_WHOAMI` pointer in `auth_providers/status.rs`; verify the doc names `src/lib/forgeHelp.ts`.

## 6. Integration

- [x] 6.1 Run `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test`; all exit 0.
- [ ] 6.2 In `bun run tauri dev`, open a GitHub, a GitLab, a Bitbucket and an Origin repo and confirm the PR tab, branch menu, Remotes legend and Accounts rows agree for each forge. — manual, pending

## Notes

- No finding was already fixed on latest; all were re-checked before editing. `MergeMethod` / `PrStateAction` live in `git/types/requests.rs` (not `git/types/forge.rs` as design.md says) and gained `Serialize` for the capability record.
- 1.1/3.3: the create gate is `canCreatePullRequests(forge)` (null forge = still detecting = capable; otherwise `forge.capabilities?.create`). `CREATE_PULL_REQUEST_PROVIDERS` / `supportsCreatingPullRequests` and `actionBarModel.canCreatePullRequest` were deleted. `PULL_REQUEST_PROVIDERS` / `supportsPullRequests` stay for surfaces that know only a provider word (remote URLs, account rows, the Remotes legend).
- Behaviour change: the PR panel's "New PR" button for a forge with `kind: null` (unrecognised host) was enabled and is now disabled, matching the branch menu and the PR list gate. The commit composer keeps its existing rule of waiting for detection (`forge != null`).
- The frontend keeps two hand-mirrors of the Rust records: `PENDING_FORGE_CAPABILITIES` in `forgeHelp.ts` (GitHub's set, used while detection is pending) and `src/test/forgeFixtures.ts` (the fixture records). The Rust dispatch test `every_absent_capability_is_a_refusing_adapter_method` pins the source.
- 2.1: `ForgeKind` gained `Copy`, serde renames, `Other` (never produced by `classify_host`), `const fn key()/label()` and `from_key()`. `ForgeProvider` is gone; `GitTransportAuthRef.provider` is `ForgeKind`. The account vocabulary (`"gh"`) is untouched. Wire strings are pinned by `serde_words_are_the_keys_and_every_stored_word_round_trips`.
- 4.1: `FORGES` lives in `src/components/chrome/forges.tsx`, not `components/ui`, because the lint rule for `components/ui` forbids `lib/api` imports and the table is keyed by the IPC `ForgeKind`. Its label and noun data are `FORGE_NAMES` in `lib/forgeHelp.ts`, which `pullRequestLabel` and `remotes.ts`'s `providerLabel` read (`PROVIDER_LABEL` deleted). The four popover builders collapsed into `prForgeModel` plus `PR_FORGE_SPEC`, and the output was checked to be identical to HEAD across every state, kind, URL, host and count. Not converted: `IdentityChip`'s forge chain, `model.ts`'s `FORGE_ICON_KEY`, `state.ts`'s chain, and the `githubEyebrow` / `githubLinks` field names.
- 4.3: commit links are built when the detail is published, from `storeLinks.openRepo().forge`. If the forge is still `null` at that moment, the row has no link until the next refresh.
- 5.1: `NotAuthenticated` gained `hint: Option<String>` (provider wording; `None` = gh wording). gh failures with a repo context go through the new `GithubError::from_command_in(ctx, …)`, which names the repository hostname and bound login. Context-free callers (account discovery, capability probes) keep `from_command` / github.com. Origin's CLI failures still map to `CommandFailed` because no fixture proves Origin's auth wording, so the spec's Origin auth case is deferred. Origin's `RepositoryNotFound` wording (A2-4) was not in the task list and is unchanged.
- 5.2: `bounded_output::capture` gained a deadline variant (`capture_until`, `CaptureError::TimedOut`), so the Settings probes keep their 4 s bound on the shared bounded capture. glab/origin probes go through `probe_glab` / `probe_origin`, which use the boundary files' command builders. `probe.rs` builds only `az` / `tea`, guarded by `every_provider_cli_probes_through_a_known_subprocess_site`. The `auth_providers` whoami now uses `oauth::identity::parse_gitlab_user`, which requires GitLab's `id` field. Origin's Windows refusal is not applied to the probe, as before.
- `GitTransportAuthRef.provider` now deserializes as `ForgeKind`, so the words it accepts grew by `cursor-origin`. Every existing word is byte-identical, and the frontend never sends the new one (it maps Origin to `"other"`).
- Visible copy changes: Settings → Accounts now shows Gitea and Forgejo with their brand mark and label (it showed the bare key with no icon before). The Remotes legend has one row per PR forge ("pull/merge requests are available.") plus "Other forges". GitLab, Bitbucket and Origin auth failures now offer "Fix authentication…", which opens Settings → Accounts for that provider, not the gh sign-in flow.
