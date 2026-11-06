# Tasks

## 1. Rust: helper read-back classification

- [x] 1.1 Add `credential_username: Option<String>` to `CommandError` in `src-tauri/src/git/types/error.rs`, with `#[serde(default, skip_serializing_if = "Option::is_none")]` (wire name `credentialUsername`), and set it to `None` in the 7 existing struct literals. Verify with `cd src-tauri && cargo check`, plus a serde test showing that `None` is omitted.
- [x] 1.2 Create `src-tauri/src/git/credentials/read_back.rs`, with `enum ReadBack { Matches, OtherUsername(String), Missing }` and a pure `read_back(filled, expected_username)` (design D). Cover these cases in unit tests: match, `x-access-token`, a case-only difference, empty output, a password without a username, and a blank expected username. Verify with `cargo test credentials::read_back`.
- [x] 1.3 Change `approve_https_credential`'s error type to `CommandError`. On a mismatch, return `kind: Auth` with `code: "credentialShadowed"`, `credential_username: Some(returned)`, and a message naming both usernames and saying case matters. When nothing comes back, return `"credentialNotReturned"`. Other errors still convert via `From<String>`. Verify with `cargo check`.
- [x] 1.4 Add a test that builds the mismatch error from fill output containing `password=SECRET`, and asserts that `SECRET` appears in no field and nowhere in the serialized JSON. Verify with `cargo test credentials`.

## 2. Rust: keychain error code and remote check

- [x] 2.1 Make `git::provider_tokens::save_provider_token` (and the `save_provider_token` command) report a keychain failure as `kind: internal`, `code: "keychain"` through `From<SecretError>`, not through `classify_failure`. Verify with a `MemoryStore`-style failing-store test asserting the code.
- [x] 2.2 Add `check_remote_access(path, remote, auth)` in `src-tauri/src/git/write/remotes/check.rs`. It resolves `transport_auth::credential_for_remote(…, Fetch, auth)` and runs `run_transport(path, cred, ["ls-remote", "--quiet", remote, "HEAD"])`, discarding the output. Verify with a test against a local bare repo (`file://` remote) that succeeds, and one where the remote name is unknown and fails with a classified error.
- [x] 2.3 Add `#[tauri::command] pub async fn check_remote_access` in `src-tauri/src/commands/remotes.rs` (async + `blocking`). Register it in `lib.rs` `generate_handler!` and add it to `LOCAL_ONLY` in `registration_tests/remote_split.rs`. Verify with `cargo test registration_tests`.
- [x] 2.4 Confirm the production half of `credentials.rs` is under 400 lines and the new files are within ceilings. Verify with `bun run sizes`.

## 3. TS API

- [x] 3.1 Add `credentialUsername?: string` to `CommandErrorPayload` in `src/lib/api/git/types/error.ts`, and document `credentialShadowed`, `credentialNotReturned` (under `auth`) and `keychain` (under `internal`). Carry the field through `src/lib/api/invoke.ts`. Add `invoke.test.ts` cases with and without the field. Verify with `bun run test src/lib/api/invoke.test.ts`.
- [x] 3.2 Add a `checkRemoteAccess(path, remote, auth)` wrapper in `src/lib/api/git/remotes.ts`, mapping to snake_case args and validating a `null` response. Verify with `bun check`.

## 4. Store: GitHub GitLane token, outcomes and checks

- [x] 4.1 Widen `StoredProviderToken.provider` in `src/store/accountsStorage.ts` to `TokenProvider = ForgeAuthProvider | "github"`, and let `transportProviderForForgeAuth` map `"github"` to the GitHub `ForgeKind`. Add a `transportAuth` test showing that a stored github.com token yields a `providerToken` ref, for a bare URL and for a `Siomkin@` URL whose token was saved as `siomkin`, and that a matching `gh` account still wins. Verify with `bun run test src/store/accounts`.
- [x] 4.2 Add `src/store/accounts/credentialChecks.ts`, composed into the credentials slice, with `checkHostRemotes(credentialHost)`. It checks each HTTPS remote of the open repo on that host, using `transportAuthForRemote(remote, "fetch")`, in parallel, and returns per-remote results. Unit-test it with `invoke` mocked inline: covering no repo, no matching remote, mixed ok/auth/network results. Verify with `bun run test credentialChecks`.
- [x] 4.3 Define `CredentialSaveOutcome` (design F). Change `saveHttpsCredential` and `saveRemoteCredential` to return it, run `checkHostRemotes` after success, and stop calling `showToast`. In `saveHttpsCredential`, apply the case-normalisation rule (design B). Update the `forgeAuth.test.ts` cases that use `.resolves.toBe(...)`. Add tests for:
  - `shadowedUsername` on `credentialShadowed`;
  - no `setRemoteUsername` and no forge-credential record after a failure;
  - no toast;
  - the case-only spelling taken from an open remote;
  - the remote card writing one value to both.

  Verify with `bun run test src/store/accounts`.
- [x] 4.4 Add `saveGithubToken(host, login, token)`. It saves through the existing provider-token path with provider `"github"`, maps a `keychain` error to `keychainUnavailable: true`, runs `checkHostRemotes`, and calls `signOutProviderToken` only when every checked remote failed with `auth`. Keep `saveProviderToken`'s public boolean for GitLab/Bitbucket. Test success, keychain unavailable, all-auth rollback, mixed results keeping the token, and network keeping the token. Verify with `bun run test src/store/accounts`.
- [x] 4.5 Make `forgetHttpsCredential` resolve `true`/`false` and keep its toast. Verify with `bun check`, and confirm that existing callers compile unchanged.

## 5. Frontend: GitHub helpers and wording

- [x] 5.1 Add `tokenHelp(provider, host)` to `src/lib/forgeHelp.ts`, with tests in `forgeHelp.test.ts` (github.com, a GHES host, other providers return `null`). Verify with `bun run test src/lib/forgeHelp`.
- [x] 5.2 Update `CREDENTIAL_HINT_STEM.github` in `src/lib/gitError.ts` to mention a personal access token, and update `gitError.test.ts`. Verify with `bun run test src/lib/gitError.test.ts`.
- [x] 5.3 Add `githubPasswordWarning(host, secret)` to `credential-entry/credentialEntry.ts`, with `credentialEntry.test.ts` cases for github.com, GHES, an empty secret and each prefix, and confirm that `canSubmit` ignores the warning. Verify with `bun run test credentialEntry`.

## 6. Frontend: forms

- [x] 6.1 Create `credential-entry/CredentialSaveError.tsx` (the inline message, "Forget @<name> and save again", "Save with Git credential helper instead", and "Use a GitLane token instead") and `credential-entry/RemoteCheckResults.tsx` (per-remote ok / failed / not checked). Both need dark: variants and focus rings. Verify with `bun check`.
- [x] 6.2 Create `provider-connect/GithubTokenForm.tsx`: username prefilled from the open repo's GitHub remote URL username, the personal access token field, the prefix warning, "Create a token" via `tokenHelp`, Save via `saveGithubToken`, and an inline outcome with check results and a keychain fallback into `saveHttpsCredential`. Add a render test (`invoke` mocked inline) covering:
  - save + check ok;
  - an auth failure that rolls back with the token kept in the field;
  - a keychain error that offers the helper fallback, which runs `approve_https_credential`.

  Verify with `bun run test GithubTokenForm`.
- [x] 6.3 In `CredentialEntryForm.tsx`, keep the outcome in state and render `CredentialSaveError` and `RemoteCheckResults`. Keep the token on failure. Wire forget-and-retry through `requestConfirm` → `forgetHttpsCredential(host, path, shadowedUsername, provider)` → one re-run. Show the case-normalisation note, and the GitHub placeholder and warning. Add a render test covering:
  - the inline error;
  - forget-then-retry calling `reject_https_credential` with the returned username, then `approve_https_credential`;
  - the warning with Save enabled.

  Verify with `bun run test CredentialEntryForm`.
- [x] 6.4 In `TransportCredentialCard.tsx`, replace the fixed "Credential was not saved…" text with the outcome message. Add the forget-and-retry offer and the check results, plus the GitHub placeholder and warning. Leave the existing Forget button as it is. Add a render test covering the backend message, forget-and-retry targeting the returned username, and card Forget targeting `account.login`. Verify with `bun run test TransportCredentialCard`, and confirm with `bun run sizes` that the file stays under 400 lines.
- [x] 6.5 In `GithubConnect.tsx`, add the "Personal access token" method card (`GithubTokenForm`), a stored GitHub token row with Remove (`signOutProviderToken`), and the "Create a token" link beside the GCM links. Verify with an `AccountsPanel.test.tsx` assertion that the card and link render, and that Remove calls `delete_provider_token`.

## 7. Frontend: Fix authentication flow

- [x] 7.1 Add `accountsConnectReason: "authFailure" | null` beside `AccountsConnectIntent` in `src/store/ui/settings.ts` (set by `openAccountsSettings(intent, reason)`, cleared with the intent and on close), and pass `"authFailure"` from the auth action in `src/store/ui/toasts.ts`. Update the existing callers and tests. Verify with `bun check` and `bun run test src/store`.
- [x] 7.2 With `reason: "authFailure"` and provider `github`, `GithubConnect` renders `GithubTokenForm` first, expanded and focused, and does not render the "Prefer the terminal?" disclosure. Add a render test asserting that the token form is first and that no `gh auth login` or other terminal command text is present. Verify with `bun run test AccountsPanel`.

## 8. Integration checks

- [x] 8.1 Run the definition-of-done suite and confirm every step exits 0:
  - `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`;
  - in `src-tauri`: `cargo check`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`.
- [x] 8.2 (moved to `docs/manual-verification-backlog.md`, Sitting B, with the user's agreement) In `bun run tauri dev`, reproduce the reported case. Configure a system-level helper that returns a stale `x-access-token` for github.com, ahead of `cache`, and use a remote URL `https://Siomkin@github.com/…`. Then:
  1. Fetch, and see the auth toast.
  2. Click "Fix authentication…", paste a valid PAT, and save.
  3. Confirm the form reports that `origin` accepted it, and that fetch, pull and push now succeed.
  4. Confirm that no terminal command appeared anywhere in the flow.
- [x] 8.3 (moved to `docs/manual-verification-backlog.md`, Sitting D, with the user's agreement) On Linux with no Secret Service running, save a GitHub token and confirm the keychain message and the helper fallback, then the forget-and-retry offer when the stale helper shadows it. Record whether GCM honours reject-by-username (design Risks).
