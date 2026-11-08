# Design

## Context

See proposal.md, Why. Engine: none is new. The account choice is written through the existing `set_remote_username` command, which already goes through the git CLI.

The per-remote account is the HTTPS URL's username. `transportAuthForRemote` resolves it in this order:

```
URL has no username --> newest token for the host, else helper/null
URL username matches a gh login (any case) --> githubGh
otherwise --> token keyed by that username, else newest token for the host, else helper
```

PR auth follows the same state: `selectDefaultAccount` returns null when the URL names no `gh` account and the stored binding is `unbound`, and `prAccountRef` then falls back to `githubTokenRef`.

Every picker choice needed already resolves correctly in transport. What is missing is a way to choose it.

## Goals / Non-Goals

**Goals:** make each case in `specs/accounts/transport/spec.md` reachable from the picker, with no transport change.

**Non-goals:** see proposal.md. This design also leaves `transportAuth.ts` resolution untouched.

## Decisions

### Decision 1: Encode the choice in the remote URL, and remember what it cannot say

| Chosen token's login | URL written |
|---|---|
| Matches a `gh` account on the host, any case | no username |
| Matches no `gh` account | the token's `transportUsername ?? login` |

A URL username cannot tell `Octocat` from `octocat`, because GitHub logins and the existing lookups are case-insensitive. A URL with no username already resolves to a token on the host, but only the newest one when several exist.

So each token choice is also saved in localStorage, keyed by repository identity and remote name, and holding the token's `providerTokenKey`. `pickProviderTokenForHost` prefers that saved token while it still exists for the remote's host and provider. Choosing anything else clears it. Repository moves carry it along with the other per-repo bindings.

Alternatives considered:
- A per-remote marker in local git config. It would be visible to other tools, but nothing outside GitLane can use a GitLane token, and it changes all four IPC layers and the remote agent.
- Treating exact letter case as the selector. It contradicts the existing "Remote URL with a username in different case" scenario.
- Making tokens outrank `gh`. It removes the choice and contradicts the "Remote bound to a gh account" scenario.

### Decision 2: `remoteAccountPickerModel` owns options and the selected option

The model gains the host's GitHub tokens and returns a list of options, each labelled with its source, plus the selected option. It stays pure and store-free: `RemoteAccountPicker` already reads `providerTokens` and passes them in.

Selection uses the same order as transport, reusing `providerTokenKey` and `pickProviderTokenForHost`. Sharing those helpers keeps the picker and transport from disagreeing.

The picker renders only with two or more options. Otherwise it shows the existing note, keeping the `hasKeychainToken` note. "Connect another…" shows whenever the picker renders, so a selected token does not hide it.

Option values must not collide between sources. `gh` options keep the account id, and token options use a `token:` prefix on the existing `providerTokenKey`.

### Decision 3: `setRemoteAccount` handles a token choice

The zustand store is `accounts`. `setRemoteAccount` takes a token choice and writes the username from Decision 1, computed by `remoteUsernameForChoice` in `accounts/transportAuth.ts` to keep `accounts.ts` under the size ceiling. On the default remote it writes the `{ version: 2, unbound: true }` binding.

Reusing `setRemoteUsername` is not enough. It does not write the binding, so a legacy `gh` binding would keep PRs on `gh` while git uses the token.

No IPC layer changes: `set_remote_username` is reused as is.

## Risks / Trade-offs

- [The saved choice lives in this app's storage, not in git] → It only matters for a URL with no username. If it is lost, such a remote falls back to the host's newest token, and the picker shows that token.
- [A repository opened over SSH] → Account references never reach the server, so the picker does not offer this computer's tokens there; `gh` accounts stay as before.
- [A user with a token can no longer pick "System git credentials"] → That option already used the token, so no working path is lost. Signing out the token restores the user's helpers.
- [A terminal `git push` on a URL with no username uses the system helper, not the keychain token] → This is already true of every keychain token, because only GitLane supplies it.
- [`src/store/accounts.ts` is at 385 lines, in the 201-400 look band] → The change is a few lines. If it would cross 400, move the URL-and-binding write into a helper under `src/store/accounts/`.

## Migration Plan

No migration. Existing remotes keep their URLs. A remote whose URL has no username and whose host has a token will now show that token as selected, which is what it was already using. Rollback restores the old picker with no data change.
