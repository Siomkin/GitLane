# Proposal

## Why

Every Bitbucket pull-request call fails for a user who saved a Bitbucket API token
under their Bitbucket username. The PR list and Create PR both show "No Bitbucket PR
sign-in found", even though Settings lists the token as healthy and the token itself
is valid. The REST client sends `Basic <git-username>:<token>`. For API tokens,
Bitbucket's REST API accepts only the Atlassian account email in that slot, or a
`Bearer` header with no username at all
([Bitbucket: Using API tokens](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/)).
Reproduced on 2026-10-18 against `GET /2.0/user`: `Basic alexander-siomkin:<token>`
→ 401, `Bearer <token>` → 200, same token. The 401 is then reported as a missing
sign-in, which sent the investigation toward the keychain instead of the auth scheme.

The failure is not limited to tokens saved under a personal username. The save form
prefills `x-bitbucket-api-token-auth` as the Bitbucket HTTPS username
(`src/lib/forgeHelp.ts` `defaultTransportUsername`). That is not the OAuth sentinel
`x-token-auth`, so a token saved with the default also gets Basic auth and a 401.
Today no saved API token works for Bitbucket pull requests. Only OAuth tokens
do, plus any app password Atlassian still accepts.

There is no Jira issue for this.

## What Changes

- Bitbucket REST calls authenticate with `Authorization: Bearer <token>` for every
  GitLane-owned Bitbucket token (OAuth access token and API token alike). The
  username no longer selects the scheme.
- **BREAKING (narrow):** the `Basic username:token` path is removed. Only Bitbucket
  app passwords needed it, and Atlassian is retiring them in favour of API tokens.
  A user still holding an app password gets the new "rejected" error below and
  re-issues an API token.
- A Bitbucket HTTP 401 is reported as "Bitbucket rejected the saved token", with a
  hint to create a new API token with scopes and save it again, naming where:
  Settings → Accounts, on the Bitbucket remote's credential, with "Try this token
  for pull requests too" checked. It is no longer reported as "no sign-in found". The missing-token case (no bound account, or no keychain entry) keeps its
  current "no sign-in found" message, so the two failures read differently.
- The token survives Bitbucket's same-host HTTPS redirects. PR diff and
  diffstat are served through a redirect, which the HTTP client followed
  without the token, so every diff returned 404. A redirect to another host
  still carries no token.
- Doc comments that describe the Basic/Bearer split by username are corrected.

## Capabilities

### New Capabilities
- `forge/bitbucket`: how GitLane authenticates Bitbucket Cloud pull-request REST
  calls with its keychain token, and how it reports a missing token versus a
  rejected one.

### Modified Capabilities
None. `forge/github` and `forge/origin` are unaffected.

## Non-goals

- No Atlassian-email field, no new token metadata, and no change to the save form.
  Bearer makes the email unnecessary.
- No change to git transport. Git over HTTPS keeps the Bitbucket username in the
  remote URL, which Bitbucket documents as valid for API tokens. The credential
  bridge and keychain key (`bitbucket` / host / account id) are untouched.
- No save-time token validation (`GET /2.0/user` when the token is saved or
  refreshed). Worth doing, but it adds UI state and belongs in its own change.
- No Bitbucket Server / Data Center support and no OAuth flow changes.
- No frontend behaviour change. `prAccountRef()` keeps sending the same
  non-secret ref. Only stale comments and two test titles that describe the old
  Basic/Bearer split are corrected.

## Impact

- **Process:** Rust, plus frontend comments and two retitled frontend tests. No
  IPC signature, command, or type changes.
- **Code:** `src-tauri/src/git/forge/bitbucket/transport.rs` (`auth_header`,
  `RestClient::new`, `map_http_error` 401 arm), `src-tauri/src/git/forge/bitbucket/mod.rs`
  (`credential` / `with_api` no longer need to thread the username into the
  client; module docs), and `transport/tests.rs`. Copy the existing Bearer branch
  of `auth_header`; no new pattern.
- **Secrets / auth:** the token still lives only in Rust for the call's duration and
  rides only in the `Authorization` header. Dropping Basic also drops the extra
  base64 payload that `RestConfig.extra_secrets` had to redact. Nothing new
  crosses IPC, and no new command takes a credential.
- **Users:** existing saved Bitbucket API tokens, under a personal username or the
  prefilled `x-bitbucket-api-token-auth`, start working for PRs with no action. App-password holders see an explicit "rejected" error instead of the
  misleading "not found".
