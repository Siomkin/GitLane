# Proposal

## Why

A GitHub remote's account picker lists only `gh` accounts, so a token saved in GitLane's keychain cannot be selected. When the token's login matches a `gh` account, as `@Octocat` (GitHub CLI) and `@octocat` (keychain token) do, the remote URL's username resolves to `gh` and the token is never used. The only way to reach the token today is to pick "System git credentials", which is mislabelled because a URL with no username already authenticates with the keychain token.

There is no Jira issue for this yet.

## What Changes

- The account picker on a GitHub HTTPS remote lists every account on that remote's host: `gh` accounts and keychain tokens, each labelled with its source so two accounts with the same login can be told apart.
- Choosing a keychain token makes git transport and pull requests on that remote use that token.
- Choosing a `gh` account keeps today's behaviour.
- "System git credentials" is offered only when the host has no saved keychain token, because with a token saved it does not use the system credentials.
- The picker shows the account that transport will actually use.

## Non-goals

- Pickers for GitLab, Bitbucket, or other non-GitHub hosts. Those keep today's note and URL-username behaviour.
- Any change to transport precedence, the IPC contract, or how tokens are stored.
- A separate per-remote setting that records the choice outside the remote URL (see design.md, Decision 1).
- Letting a remote use the user's own credential helper while a keychain token exists for its host. Signing the token out remains the way to do that.
- Merging or normalising the two rows on the Accounts page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `accounts/transport`: adds the requirements for choosing any of a GitHub host's accounts per remote, including a keychain token whose login matches a `gh` account.

## Impact

- Process: frontend only. No Rust, IPC, or dependency change.
- Code: `src/components/chrome/repo-settings/remotes-panel/` (`remoteAccountOptions.ts`, `RemoteAccountPicker.tsx`) and `setRemoteAccount` in `src/store/accounts.ts`.
- Pattern to copy: `remoteAccountPickerModel` stays the pure view-model. The selected option mirrors the lookup in `transportAuthForRemote` in `src/store/accounts/transportAuth.ts`.
- Secrets, auth, IPC: the picker uses only the non-secret token metadata already in the store (`providerTokens`). No token crosses IPC or enters JS, and `save_provider_token` is unchanged. The security-relevant effect is which credential git sends for the remote, and only the user's explicit choice changes it.
