# Design

## Context

Engine: `forge::context()` provider. This is the Bitbucket REST provider under
`src-tauri/src/git/forge/bitbucket/`, with no libgit2 or git CLI involved.

Current flow for any Bitbucket PR operation:

```
 frontend prAccountRef()                     Rust BitbucketProvider
 {native, host, accountId,                   credential(ctx)
  login = transportUsername ?? login}  -->     keychain get(bitbucket, host, accountId)  -- miss --> no_bitbucket_auth
                                               returns (token, account.login)
                                             with_api -> RestClient::new(http, host, username, token)
                                               auth_header(username, token)
                                                 "x-token-auth" | ""  -> Bearer token
                                                 anything else        -> Basic b64(user:token)   <-- 401 for API tokens
                                             map_http_error: 401 -> no_bitbucket_auth           <-- same text as a miss
```

`RestClient::new` already passes the Basic base64 payload to the shared
`rest::RestClient` as `extra_secrets`, so the encoded form is redacted from errors.
GitLab's adapter (`gitlab/transport.rs`) is the sibling to copy. Its constructor
is `RestClient::new(http, host, token)` with `extra_secrets: &[]`.

See proposal.md (Why) for the reproduction.

## Goals / Non-Goals

**Goals:**
- One auth scheme for Bitbucket REST: Bearer.
- The username stops flowing into the REST client.
- A 401 and a keychain miss produce different, actionable messages.

**Non-Goals:**
- No change to the account ref that crosses IPC, the frontend stores, or the
  `prAccountRef()` shape. `login` keeps feeding the "Opening as" label.
- No new IPC command or type, so the four IPC layers are untouched.
- No new store state, and no folder-module split.

## Decisions

### D1. Always Bearer, with no username-based fallback

`auth_header` collapses to `Bearer {token}`. Bitbucket documents Bearer for both
OAuth access tokens and API tokens, and Bearer needs no email.

Alternatives considered:
- **Store the Atlassian email and send `Basic email:token`.** This needs a new
  form field, new metadata, and frontend wiring, all to reach the same result Bearer
  gives for free. Rejected.
- **Bearer first, then retry Basic on a 401.** This doubles requests on every
  real 401, and keeps a code path whose only users hold app passwords, which
  Atlassian is retiring. Rejected (see Risks).

### D2. Drop the username from `RestClient::new`

The signature becomes `RestClient::new(http, host, token)`, matching GitLab's
adapter. `BitbucketProvider::credential` returns just the token, and
`with_api` stops threading `account.login`. `OAUTH_USERNAME` loses its last
non-test use in the transport and is removed. `oauth/config.rs` keeps its own
`transport_username` for git, which is unaffected. Bitbucket passes
`extra_secrets: &[]` because there is no derived payload left to redact.

That leaves `rest::RestConfig.extra_secrets` with no production user, since
GitLab already passes `&[]`. The field stays as a generic option for a future
adapter whose auth header encodes the token. Its own test,
`extra_secrets_cover_basic_payloads_including_padded_encodings` in
`rest/tests.rs`, keeps guarding it. The Bitbucket test that tied that fixture to
the real encoder (`auth_header_encodes_the_padded_basic_payload`) goes away with
the Basic branch.

Keeping a now-unused `username` parameter was rejected: it would tell the next
reader the username still matters. The cost is a mechanical update of 29 test
call sites (9 in `transport/tests.rs`, 20 in `ops/tests/*.rs`) that pass
`"x-token-auth"`, `OAUTH_USERNAME` or `"alice"`.

### D3. A 401 gets its own `NotAuthenticated` hint

The `map_http_error` 401 arm returns `GithubError::NotAuthenticated` (same kind,
so the "Fix authentication…" action is unchanged), with a hint along the lines
of: "Bitbucket rejected the saved token for {host}. It may be expired, revoked,
or an app password. Create an API token with scopes in your Atlassian account,
then save it in Settings → Accounts on the Bitbucket remote's credential with
'Try this token for pull requests too' checked." `no_bitbucket_auth` stays as
the keychain-miss and no-account message. A dedicated helper next to it,
`bitbucket_token_rejected(host)`, keeps both strings in `mod.rs` where the
existing message test lives.

The rejected hint mentions API tokens on purpose. The no-sign-in message must not
(`no_bitbucket_auth_names_git_transport_fallbacks_not_gh` asserts it), because
token setup is deliberately not advertised to users who never chose it. A 401 is
only reachable by someone who already saved a token, so naming the token and the
exact place to replace it is the actionable answer there. The token is saved
only through that checkbox (`TransportCredentialCard.tsx`) or the clone flow
(`runClone.ts`), and the hint names the Settings path because it is the one a
user can return to.

### D4. Corrected comments and test titles

These places describe the old split by username and are corrected:

- module docs in `bitbucket/mod.rs` and `bitbucket/transport.rs`
- `rest.rs` module doc and the `extra_secrets` field doc, which cite "Bitbucket's
  base64 Basic payload" as the example; make it a generic encoded-token example
- `src/store/accounts/transportAuth.ts`: the `prAccountRef()` Bitbucket branch,
  and the `tokenRef` comment ("the handle for a PAT")
- `src/lib/forgeHelp.ts` `defaultTransportUsername`, which should add that the
  username matters for git only, since PR REST calls use Bearer
- `src/store/providerToken.test.ts`: the two test titles "→ backend uses Bearer"
  and "→ backend uses Basic (API token)". The ref assertions stay, and only the
  titles change, because the frontend still sends the same ref.

None of these changes behaviour.

### D5. Keep the token on same-host HTTPS redirects

Found during the in-app check: the PR list loaded, but every PR diff returned
404 "You may not have access to this repository…". Bitbucket answers
`pullrequests/{id}/diff` (and `/diffstat`) with a redirect to a repository diff
on the same host, `api.bitbucket.org`. ureq 3 defaults to
`RedirectAuthHeaders::Never`, so it dropped `Authorization` on the redirect, and
Bitbucket treated the follow-up as anonymous. The bug predates this change; the
401 on Basic auth had hidden it.

`UreqTransport` sets `redirect_auth_headers(RedirectAuthHeaders::SameHost)`:
the header survives only a redirect to the same host over HTTPS, so a token
can never follow a redirect elsewhere. This is set once on the shared agent, so
GitLab REST and the OAuth flows get the same rule, which is safe for each of them.

Alternatives considered:
- **Call the repository diff endpoint directly** from the PR's source and
  destination commits. That avoids the redirect, but it needs the detail call
  first and re-implements Bitbucket's own spec logic. Rejected.
- **`Always`.** It would send the token to any redirect target. Rejected.

## Risks / Trade-offs

- [A user still on an app password loses PR access] → They already get a 401 if
  Atlassian has disabled app passwords. Otherwise they now see the rejected-token
  message telling them to issue an API token. The
  investigation found no evidence that app passwords still work against
  `api.bitbucket.org`, but it did not test one either.
- [Bearer behaves differently for some token kind not tested here] → The behaviour
  was reproduced with a scoped API token (read/write repository, pull request,
  user). OAuth tokens already used Bearer, so they don't change.
- [The token leaks through an error path once `extra_secrets` is empty] → The
  shared `rest::RestClient` still redacts `token` itself. Keep the existing
  redaction tests, adapted to Bearer, as the guard.

## Migration Plan

None needed. Saved tokens and keychain keys are unchanged, and existing API-token
users start working on the next PR call. Rolling back means reverting the change.

## Size

All touched files are under the Rust look band (`mod.rs` 209, `transport.rs`
189, `transport/tests.rs` 266 lines), and the change shrinks them. No split is
needed.
