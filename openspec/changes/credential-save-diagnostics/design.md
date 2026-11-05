# Design

## Context

See proposal.md for the motivating case. The relevant current state:

- **Git transport resolution.** For HTTPS remotes this happens in the frontend, `transportAuthForRemote` (`src/store/accounts/transportAuth.ts`), and Rust validates it (`src-tauri/src/git/transport_auth.rs::credential_for_credential_host`).
  - With a URL username, the order is: a `gh` account whose login matches → a GitLane keychain token (`providerTokens` keyed by host and username, else any token for the host) → glab → the user's helper.
  - Without a URL username: a keychain token for the host → glab → nothing (the user's helpers).
- **`providerToken` mode** (GL-132) is already provider-neutral in Rust. `save_provider_token` accepts any lowercase provider key (`provider_tokens::validate_provider`). `GitTransportAuthRef::ProviderToken` carries a `ForgeKind`, which includes GitHub. `credential_bridge::provider_token_invocation` adds `-c credential.https://<host>.helper=` (an empty value resets the helper list git has collected so far, including `/etc/gitconfig`'s `manager`) and answers git's prompt through `GIT_ASKPASS` from a command-scoped broker.
- **What blocks GitHub today** is only the frontend:
  - `PROVIDER_TOKEN_AUTH_PROVIDERS` is `{gitlab, bitbucket}`.
  - `ForgeAuthProvider` (and so `StoredProviderToken.provider` and `saveProviderToken`) has no `"github"`.
  - `GithubConnect` offers no token form.
  - `transportAuthForRemote` would already pick up a stored github.com token through `pickProviderTokenForHost` if one existed.
- **Keychain.** It uses `keyring` 4 (`v1`: Keychain / Credential Manager / zbus Secret Service). On Linux with no Secret Service on the session bus (headless, minimal window managers, some containers), `set_password` fails and `KeyringStore::set` returns `SecretError("Could not save the token to the keychain: …")`. `provider_tokens::save_provider_token` returns `String`, so that failure reaches IPC through `classify_failure`, not as the existing `internal`/`keychain` code that `From<SecretError>` gives. A locked collection usually triggers the desktop's own unlock prompt, which is fine.
- **The helper path.** `approve_https_credential` runs `git credential approve` and then `fill`. It returns the generic "Git credential helper did not return the saved credential." whenever the read-back has no matching username. Helpers answer in config order, and the first one with a password wins (its `username=` overrides the requested one).
- **Store actions.** `saveHttpsCredential` and `saveRemoteCredential` send errors to `showToast` and return `false`. The toast is hidden under the Settings modal.
- **Fix authentication.** The toast's "Fix authentication…" (`src/store/ui/toasts.ts`) calls `openAccountsSettings(provider)`. The Accounts panel consumes `accountsConnectIntent` and lands on that provider's connect view. `GithubConnect` shows a "Prefer the terminal?" disclosure with `gh auth login`.
- **ls-remote.** `run_transport(repo, cred, ["ls-remote", …])` already exists in `git/write/remotes/push.rs`, with `GIT_TERMINAL_PROMPT=0` from the write CLI.
- **File sizes.**
  - `credentials.rs`: 626 lines, about 376 in production code (look band) and about 250 in tests.
  - `TransportCredentialCard.tsx`: 279 lines (look band).
  - `CredentialEntryForm.tsx`: 120. `GithubConnect.tsx`: 93. `transportAuth.ts`: about 320.

## Goals / Non-Goals

**Goals:**

- A valid pasted GitHub token makes fetch, pull and push work in GitLane, whatever the user's helpers do, with no terminal step.
- Every failure in these forms is shown inline, with a recovery the user can click.
- The user learns whether the credential works when they save it.

**Non-Goals:**

- No changes to the user's git config files.
- PRs for a pasted GitHub token are out of scope (PRs stay on `gh`).
- The `gh`-bound precedence stays as it is (the existing "authenticates as the bound gh account" requirement is unchanged).

## Decisions

### Engine

These are git CLI operations: `git credential approve` / `fill` / `reject`, and `git ls-remote` through the existing transport runner. Token storage is the existing keychain module. No libgit2 and no forge provider.

### A. A GitLane-owned token is the default for GitHub, and the helper path is the fallback

Options evaluated:

1. **GitLane-owned token (`providerToken`)**
   - The bridge resets the inherited helper list for the host on every invocation, so a stale GCM entry is never asked. That makes it the only option that works without touching the user's config.
   - The username cannot break it either: git takes the username from the remote URL and asks only for the password (or asks the askpass for both on a bare URL), and GitHub ignores the username when it gets a PAT.
   - The Rust side already supports it. The frontend needs `"github"` as a token provider, a form, and a way to remove the token.
   - Cost: it needs a working OS keychain, and it applies only inside GitLane (a terminal `git` still uses the user's helpers, which is correct, because GitLane must not rewrite their config).
2. **Helper path with in-app recovery**
   - It keeps the credential in the user's own helper, so terminal `git` also benefits.
   - But it only works if forgetting the shadowing entry actually removes it. That depends on the helper honouring `git credential reject` by username, which is unverified for GCM. And GCM can recreate an `x-access-token` entry on its next interactive sign-in.

**Choice:** option 1 is the default for a token pasted on the GitHub page ("Personal access token" method card, first after GitHub CLI). Option 2 is what the existing "Git Credential Manager" method uses, and it is the offered fallback when the keychain is unavailable. It is also offered alongside option 1 when a helper save is shadowed and the keychain works.

Why: option 1 fixes the reported case without depending on another program's behaviour. Option 2 stays because some users deliberately want the credential in their helper, and because Linux without a Secret Service has nothing else.

**Linux with no Secret Service.** `save_provider_token` makes a `SecretError` arrive as `kind: internal`, `code: keychain` (the `From<SecretError>` path that already exists), not a classified string. The form branches on that code. It shows "This system has no available secure storage for GitLane's token" and offers "Save with Git credential helper instead", which runs the option-2 flow with the same token. If `approve_https_credential` then reports no configured helper, the form says neither is available and points to SSH. **Open decision, below.**

**Precedence.** `transportAuthForRemote` already orders `gh`-bound account → keychain token → helper. That stays as it is. A remote bound to a working `gh` account is not the broken case, and the existing spec pins that order. The "Fix authentication…" flow for GitHub therefore saves a host-level token, which applies to every remote on that host with no matching `gh` binding.

*Alternative: always prefer a pasted GitLane token over `gh`.* Rejected: it changes an existing requirement, and it would silently override a working multi-account `gh` setup.

### B. Username consistency

- **GitLane-token path:** consistent by construction. `transportAuthForRemote` first looks up `providerTokenKey(host, urlUser)` and then falls back to `pickProviderTokenForHost(host)`, which ignores the username. The bridge answers only what git asks for. The token form prefills the username from the open repo's remote URL on that host, and uses it as the keychain `login`/`accountId`.
- **Remote card:** `saveRemoteCredential` already approves and writes the remote URL username from the same trimmed value. Keep that, and pin it with a test.
- **Helper form (host-level):** before saving, look at the open repo's HTTPS remotes on the same credential host. If one has a URL username equal to the typed one ignoring case, but different in case, save under the URL's spelling, and show "Saved for `Siomkin`, the spelling `origin` uses." GitLane does not rewrite remote URLs from this form. Using the URL's spelling makes the two identical without touching repo config. If two remotes on the host spell it differently, use the typed value and show the read-back result.
- **Backstop:** the read-back (Decision D) names any username that still differs.

*Alternative: lowercase everything.* Rejected: Git compares usernames exactly, so changing the case of either side can break a working remote.

### C. Check after save: a new non-secret command `check_remote_access`

- `check_remote_access(path, remote, auth: Option<GitTransportAuthRef>) -> Result<(), CommandError>`.
- It resolves the credential with `transport_auth::credential_for_remote(…, Fetch, auth)` and runs `run_transport(path, cred, ["ls-remote", "--quiet", <remote>, "HEAD"])`. That is the exact fetch transport, and `HEAD` bounds the output to one line.
- Failures go through the existing transport classification (`auth` / `network` / …).
- It carries no secret: `auth` is the existing non-secret ref. It is `LOCAL_ONLY`, because Settings credential flows apply to local repositories and remote repositories use the server's credentials.

The frontend action `checkHostRemotes(credentialHost)` in the accounts store:

- lists the open repo's remotes whose fetch URL is HTTPS on that credential host;
- calls the check for each with `transportAuthForRemote(remote, "fetch")`;
- returns per-remote results: `ok`, or `{ message, kind }`.

What happens on the result:

- On the token path, an `auth` failure for every checked remote calls `signOutProviderToken`, so a rejected token never shadows the user's helper. The token stays in the form field.
- A `network` failure keeps the token and reports "saved, not checked".
- With no open repo or no matching remote, the form says the credential is saved and will be used on the next fetch.

*Alternative: check through the GitHub REST API (`/user`).* Rejected: it needs an HTTP client for GitHub in the backend. It would also check the token rather than the remote: an SSO-unauthorised or wrong-scope token passes `/user` but fails `ls-remote`.

### D. Helper read-back as structured `CommandError` (unchanged from the first draft)

- `approve_https_credential` returns `CommandError` directly for the read-back failure:
  - `kind: auth`;
  - `code: "credentialShadowed"` (another username came back) or `"credentialNotReturned"` (nothing came back);
  - a new optional field `credentialUsername` (omitted when absent) holding the returned username.
- The message names both usernames and says Git matches usernames exactly, case included.
- The pure check lives in `git/credentials/read_back.rs`:
  - `enum ReadBack { Matches, OtherUsername(String), Missing }`;
  - it reads `username=` and checks only that a `password=` line *exists*;
  - tests assert the password never appears in the resulting error or its JSON;
  - a blank expected username keeps today's "any username with a password" behaviour;
  - a password with no username counts as `Missing`.
- The submodule also keeps `credentials.rs`'s production half under 400 lines.

*Rejected alternatives:*

- A `readBack` outcome on `Ok`: every caller would have to treat success as failure.
- Putting the username in `detail`: the UI would have to parse it.
- Comparing the returned secret too: GCM may legitimately return a different secret on OAuth-backed hosts, which would break saves that work today.

The `ipc/commands` spec requires `kind`, `message` and an optional `detail`, and does not list every field, so it needs no delta.

### E. Forget-and-retry on the helper path

When a save outcome has a `shadowedUsername`, the form shows "Forget @<name> and save again".

- It goes through `requestConfirm`, then `forgetHttpsCredential(host, path, shadowedUsername, provider)`, then one re-run of the same save, followed by the check (C).
- `forgetHttpsCredential` resolves `boolean` (an additive change; it keeps its toast for other callers).
- A second mismatch shows its own offer. Where the keychain is available, it also shows "Use a GitLane token instead", which moves the same field value into the token save (A). GitLane never loops on its own.
- The card's existing Forget button is unchanged.

### F. Store action shape

```ts
type CredentialSaveOutcome =
  | { ok: true; checks: RemoteCheck[] }
  | { ok: false; message: string; shadowedUsername: string | null; keychainUnavailable: boolean };
```

- It is returned by `saveHttpsCredential`, `saveRemoteCredential`, and a new `saveGithubToken(host, login, token)`.
- `saveGithubToken` wraps `saveProviderToken("github", …)` plus `checkHostRemotes`, and rolls back on an auth failure.
- `message` is `friendlyGitError` output, so it is never raw.
- These actions stop calling `showToast`, because the form is the reporting surface.
- `saveProviderToken` keeps its boolean for GitLab and Bitbucket. Internally it gains the error detail that `saveGithubToken` needs: an inner helper returns the caught error, and the public action maps it to `boolean`.
- A bare string return was rejected, because the forms need several fields.

### G. Fix authentication flow

- `AccountsConnectIntent` stays the provider string, and a separate `accountsConnectReason: "authFailure" | null` sits beside it (set by `openAccountsSettings(intent, reason)`, cleared together). This keeps existing callers unchanged.
- The toast's auth action passes `reason: "authFailure"`.
- With that reason and provider `github`, `GithubConnect` renders the token method card first, expanded and focused, with:
  - the username prefilled from the open repo's first HTTPS remote URL username on github.com (or the failing host, when the error names one);
  - "Create a token";
  - Save, followed by the check results.
- In this mode the "Prefer the terminal?" disclosure is not rendered, and the other method cards stay below the token card.
- Other providers keep today's behaviour.

### H. GitHub wording and prefix warning

- `tokenHelp(provider, host)` in `src/lib/forgeHelp.ts` is shaped like `sshKeyHelp`. GitHub uses `https://<host>/settings/tokens`; other providers return `null`.
- The placeholder for GitHub is "Personal access token (fine-grained or classic)".
- `CREDENTIAL_HINT_STEM.github` mentions a personal access token, and `gitError.test.ts` updates to match.
- `githubPasswordWarning(host, secret)` in `credential-entry/credentialEntry.ts` applies only when the trimmed host is exactly `github.com` and the secret lacks the five prefixes. It is amber text and never feeds `canSubmit`.

### IPC layers that change (four-layer contract)

1. **Impl:**
   - `git/credentials.rs` plus `git/credentials/read_back.rs`;
   - a new `check_remote_access` in `git/write/remotes/` (a `check.rs` beside `transport.rs`);
   - `git/provider_tokens.rs`: keychain errors keep `code: keychain` (return `CommandError`, or a typed error that converts through `From<SecretError>`).
2. **Command + handler:**
   - a new `commands/remotes.rs::check_remote_access`, registered in `lib.rs`'s `generate_handler!` and added to `registration_tests/remote_split.rs` `LOCAL_ONLY`;
   - the `approve_https_credential` and `save_provider_token` signatures are unchanged;
   - `secret_paths.rs` is unchanged, because there is no new secret parameter.
3. **Types:** `git/types/error.rs` gets `credential_username: Option<String>` (`skip_serializing_if`) in the 7 struct literals. `check_remote_access` returns `()`, so it needs no new DTO.
4. **TS api:**
   - `src/lib/api/git/types/error.ts` (field and codes);
   - `src/lib/api/invoke.ts` (carry the field);
   - `src/lib/api/git/remotes.ts` (the `checkRemoteAccess` wrapper, with `z.null()` validation);
   - `src/lib/api/providers.ts` `ForgeAuthProvider` is not widened. The token-provider type is widened instead, see below.

### Stores and file layout

- **Accounts store only.**
  - `credentials.ts`: the outcome type, `saveGithubToken`, and `checkHostRemotes`.
  - `transportAuth.ts`: `transportProviderForForgeAuth` accepts `"github"`.
  - `accountsStorage.ts`: `StoredProviderToken.provider: TokenProvider = ForgeAuthProvider | "github"`.

  This keeps GitHub out of `FORGE_AUTH_PROVIDERS`, the forge-auth status rows and the CLI sign-out paths it does not belong to. `credentials.ts` is about 297 lines and would pass 400 with these additions, so move the check and the GitHub token action into `src/store/accounts/credentialChecks.ts` and compose it into the slice.
- **UI.**
  - A new `provider-connect/GithubTokenForm.tsx` (token form with check results).
  - A shared `credential-entry/CredentialSaveError.tsx` (inline error, forget offer, keychain fallback offer).
  - A shared `credential-entry/RemoteCheckResults.tsx`.
  - `GithubConnect` takes the intent. `TransportCredentialCard` (279 lines) gains about 30 lines, so it stays under 400. If it crosses that, move its reducer to `transportCredentialDraft.ts`.
- **Dependencies.** No new dependency, plugin or capability, and `docs/tauri-plugin-decisions.md` is untouched.

## Risks / Trade-offs

- [The keychain works at save time but is locked or missing at fetch time] → The bridge fails with "No stored token is available…" or a read error. The fetch toast's "Fix authentication…" leads back to this flow. `reconcileProviderTokens` already prunes metadata whose secret is gone.
- [GCM honouring `reject` by username is unverified] → Option 2 is no longer the default for GitHub. A failed forget re-shows the mismatch, with the GitLane-token offer. A manual check is in tasks.
- [Rolling back a token on an auth failure could remove a token that is valid for other repos, when only an SSO-restricted repo rejected it] → Roll back only when *every* checked remote fails with `auth`. A mixed result keeps the token and lists the failing remotes.
- [The check costs one network round trip per matching remote] → It runs only after an explicit save, uses `HEAD` only, and runs remotes in parallel.
- [`check_remote_access` for a remote repository tab] → It is `LOCAL_ONLY` and rejects a remote locator with `unsupportedOnRemote`. Settings credential forms already apply to local repositories only.
- [Adding a field to `CommandError` touches 7 struct literals] → The compiler finds each one.
- [The prefix list goes stale] → It is a warning only.

## Open Questions

- **Open decision: a machine with neither an OS keychain nor a credential helper** (some minimal Linux setups). This change shows a clear message and suggests SSH. Making HTTPS work there needs GitLane to hold a secret somewhere new. Options:
  - (a) a token kept only in the running process's memory for the session;
  - (b) a GitLane-encrypted file store;
  - (c) writing a repo-local `credential.helper=cache` with the user's consent.

  Each is a new secret-storage decision under the rules in `CLAUDE.md` / `docs/rules/architecture-rules.md` §1–2, so it is left for the user and is not part of this change's tasks.
