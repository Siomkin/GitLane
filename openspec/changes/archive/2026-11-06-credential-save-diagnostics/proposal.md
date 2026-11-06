# Proposal

## Why

A user on Ubuntu (GitLane 2.5.3) could not fetch from GitHub over HTTPS, and Settings > Accounts never told them why. First they typed their account password, which GitHub has not accepted for Git since 2021. Then a valid classic PAT "failed to save". The real cause was two configured credential helpers: the system `manager` (GCM) and the global `cache`. GCM answers every github.com request with a stale `x-access-token` + old token. That made GitLane's read-back check after `git credential approve` fail, and it made the fetch fail too. The only error text went to toasts, which the Settings modal hid.

Many people use GitLane, and none of them should have to run a terminal command to fix this. Clearer messages are not enough. Pasting a valid GitHub token in Settings has to make fetch, pull and push work, even when the user's own helper chain is broken, and the app has to say right away whether it worked.

## What Changes

- **A GitLane-owned token is the default for a pasted GitHub token.** GitLane already has a `providerToken` transport mode for GitLab and Bitbucket (GL-132): the token lives in the OS keychain and reaches git through GitLane's `GIT_ASKPASS` bridge. That bridge clears the host's inherited helpers for the invocation, so a stale GCM entry cannot interfere. This change enables that mode for GitHub (github.com and GitHub Enterprise Server). It also adds a "Personal access token" connect method on the GitHub page, and a way to remove that token again.
- **A keychain-unavailable fallback.** When the OS keychain cannot store the token (typically Linux with no Secret Service), the form says so plainly and offers to save the same token through the user's Git credential helper instead. That is the helper path below.
- **In-app recovery on the helper path.** When the read-back after `git credential approve` returns a credential for a different username, the save fails with a message that names that username (never the secret). The form then offers one click to forget that stale entry (`git credential reject` for that username, run by GitLane) and save and verify again. The failure is classified in the backend (`kind: auth`, a new `code`, and the returned username as structured data).
- **The username is always the same on both sides.** On the GitLane-token path the username cannot break a fetch at all: the token is found by host, and git takes the username from the remote URL. On the helper path, the per-remote card already writes the remote URL username and the credential from one value. The host-level helper form now saves under the spelling an open repo's remote URL already uses for that host whenever the typed username differs from it only in case.
- **Check after save.** After a save succeeds, GitLane runs `git ls-remote <remote> HEAD` for each HTTPS remote of the open repository on that host, with the same transport auth a fetch would use. It then reports "works" or the real failure inline. On the GitLane-token path, a token that the server rejects is removed again, so a bad token never shadows the user's helper.
- **"Fix authentication…" ends with a working remote.** For a GitHub auth failure, the toast's action opens a focused GitHub token flow: paste the token, save, check. The flow mentions no terminal command (the "Prefer the terminal?" disclosure is not shown in it).
- **Inline errors everywhere in these forms.** The helper form and the per-remote card show the backend's real message inline instead of a hidden toast or the fixed "Credential was not saved. Check the error and try again."
- **GitHub token wording.** The GitHub secret field is a personal access token (fine-grained or classic), not a password. There is a "Create a token" link (on GitHub Enterprise Server, the host's own token page). The `credentialsMissing` hint for GitHub mentions tokens. A soft warning, never a block, appears for a github.com secret without a known token prefix (`ghp_`, `github_pat_`, `gho_`, `ghu_`, `ghs_`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `accounts/transport`: adds requirements for GitHub GitLane-owned tokens, the keychain fallback, failed-save reporting and recovery, username consistency, the post-save check, and the auth-failure fix flow. No existing requirement changes.

## Impact

- **Processes:** Rust, IPC and frontend.
  - Rust: `git/credentials.rs` read-back and error; a new remote-access check in the write layer; a keychain error code from `save_provider_token`.
  - IPC: one new non-secret command, `check_remote_access`; one new optional `CommandError` field and new `auth` codes.
  - Frontend: the accounts store (credential actions, provider-token provider set, transport resolution for GitHub), GitHub connect view, `CredentialEntryForm`, `TransportCredentialCard`, the toast's auth action and settings intent, `lib/forgeHelp.ts`, `lib/gitError.ts`.
- **Jira:** none. No GL ticket exists for this change.
- **Secrets / auth risk:** no new command carries a secret. The GitHub token goes through the existing `save_provider_token` (into the keychain) or the existing `approve_https_credential` (to the user's helper). This keeps the "exactly three commands may carry a user-entered secret" rule. `check_remote_access` takes only a remote name and a non-secret transport auth ref. The read-back sees the helper's `password=` line in-process only and never compares, logs, returns or persists it. Only the returned *username* crosses IPC. No token goes into JS or Zustand state beyond today's transient form field.
- **Existing patterns to copy:**
  - The GitLab/Bitbucket `providerToken` flow (`saveProviderToken`, `transportAuthForRemote` → `tokenRef`, `credential_bridge::provider_token_invocation`).
  - `push.rs`'s `run_transport(… "ls-remote" …)` for the check.
  - `sshKeyHelp` for the token link.
  - `CommandError`'s optional context fields (`remote_failures`) for the new field.
  - The `accountsConnectIntent` settings slice for the fix flow.
- **Callers that change:** `saveHttpsCredential` and `saveRemoteCredential` return a result object instead of `boolean` (their tests in `src/store/accounts/forgeAuth.test.ts` change). `runClone.ts` calls the API directly and just gets the clearer error message.

## Non-goals

- GitLane does not edit the user's git config: no helper reordering, no global or system `credential.*` writes, no removing GCM. A `git` the user runs in a terminal keeps their own helper behaviour.
- A GitHub token pasted here does not enable pull requests. GitHub PRs still use `gh`.
- No change to GitLab, Bitbucket, Azure or other providers' wording or connect views, beyond what the shared inline-error and check paths give them.
- No comparison of the returned secret with the saved one (see design).
- No new storage of secrets outside the OS keychain and the user's own helper. For a machine with neither, see the open decision in design.md.
- No change to remote (SSH) repositories, which keep using the server's own credentials.
- The `openspec/config.yaml` context still says "exactly two commands may carry a secret", while `CLAUDE.md` and `ipc/commands` say three. That stale wording is not fixed here.
