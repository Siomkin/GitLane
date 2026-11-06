# Spec Delta

## ADDED Requirements

### Requirement: A pasted GitHub token authenticates git despite a broken helper chain

The user MUST be able to paste a GitHub personal access token in Settings > Accounts and have GitLane store it as its own token. Fetch, pull and push on that host's HTTPS remotes MUST then authenticate with it, whatever the user's configured credential helpers return. A remote bound to a signed-in `gh` account keeps using that account.

#### Scenario: Stale helper entry ahead of the user's helper

- **WHEN** the system git config has a helper that returns a stale `x-access-token` credential for every github.com request, and the user saves a valid token in GitLane's GitHub token form
- **THEN** a fetch, pull or push from a github.com HTTPS remote in GitLane authenticates with the saved token and succeeds, with no terminal step

#### Scenario: Remote URL with a username in different case

- **WHEN** the remote URL is `https://Siomkin@github.com/…` and the user saved the token under `siomkin`
- **THEN** the fetch authenticates with the saved token

#### Scenario: Remote bound to a gh account

- **WHEN** a GitHub remote is bound to a signed-in `gh` account and a GitLane token is also saved for github.com
- **THEN** that remote still authenticates as the bound `gh` account

#### Scenario: GitHub Enterprise Server

- **WHEN** the user saves a token for a GitHub Enterprise Server host
- **THEN** that host's HTTPS remotes authenticate with it, and github.com remotes are unaffected

#### Scenario: Removing the token

- **WHEN** the user removes the saved GitHub token in Settings > Accounts
- **THEN** GitLane deletes it from the OS keychain, and that host's remotes go back to the user's own credential helpers

### Requirement: Saving falls back to the credential helper when the keychain is unavailable

If the OS keychain cannot store the token, the form MUST say the system has no available secure storage, keep the token in its field, and offer to save it with the user's Git credential helper instead. The user's helpers MUST NOT be changed without that choice.

#### Scenario: Linux without a Secret Service

- **WHEN** the user saves a GitHub token on Linux where no Secret Service is running
- **THEN** the form says the keychain is unavailable and offers "Save with Git credential helper instead", and choosing it runs the helper save and its checks

#### Scenario: No keychain and no helper

- **WHEN** the keychain is unavailable and no Git credential helper is configured
- **THEN** the form says neither secure storage nor a credential helper is available, and suggests SSH as the alternative, without showing any terminal command

### Requirement: A failed HTTPS credential save is reported in the form that started it

When saving a credential from Settings > Accounts fails, in the token form, the helper form or a remote's credential card, the reason MUST appear inline in that form, using the backend's own message. A generic "not saved" text alone is not enough. The typed token MUST stay in its field. Success MUST clear the token and any earlier error.

#### Scenario: Helper form save fails

- **WHEN** the user saves a token in the Git Credential Manager / helper form and the backend rejects the save
- **THEN** the form shows that rejection's message, and the token field still holds the token

#### Scenario: Remote card save fails

- **WHEN** the user saves a token on a remote's HTTPS credential card and the backend rejects the save
- **THEN** the card shows the backend's message in place of "Credential was not saved. Check the error and try again."

#### Scenario: Retry succeeds

- **WHEN** a save that failed is retried and succeeds
- **THEN** the inline error is gone and the token field is cleared

### Requirement: The helper read-back names the username a helper returned instead

After a helper save, GitLane asks Git to read the credential back. If a helper returns a credential for a different username, the save MUST fail with an `auth` error that names the returned username and says Git matches usernames exactly, case included. The returned username MUST be provided as structured data, not only in the message.

#### Scenario: Another helper shadows the saved credential

- **WHEN** the user saves a token for `siomkin` on `github.com` through the helper, and the read-back returns a credential for `x-access-token`
- **THEN** the save fails, the message names `x-access-token` as the username Git returned instead of `siomkin`, and the error carries `x-access-token` as data

#### Scenario: Helper returns nothing

- **WHEN** the read-back returns no credential at all
- **THEN** the save fails with a message that the credential helper did not return the saved credential, and the error carries no returned username

### Requirement: The returned secret never leaves the read-back

The read-back MUST NOT log, return, persist, or put into any error or event the secret the helper returned, or the secret the user saved. Only the returned username may cross IPC.

#### Scenario: Error payload of a mismatched read-back

- **WHEN** a read-back returns a different username together with a password
- **THEN** no field of the rejection contains that password or the saved token

### Requirement: One click forgets the credential that shadowed a helper save

When a helper save fails because a different username came back, the form MUST offer to forget that username's saved credential on the same host and path, after a confirmation. GitLane MUST then save and verify again, with the token still in the field. The card's existing Forget action MUST still forget only the remote's own username.

#### Scenario: Forget the stale entry and save again

- **WHEN** a helper save failed because `x-access-token` came back, and the user confirms "Forget @x-access-token and save again"
- **THEN** GitLane asks Git to forget the `github.com` credential for `x-access-token` only, then saves and verifies the typed token again

#### Scenario: Shadowing persists

- **WHEN** the forget succeeds but the next read-back still returns a different username
- **THEN** the form shows the new mismatch with its own forget offer, plus the GitLane-token option where the keychain is available, and GitLane does not retry by itself

#### Scenario: Card Forget is unchanged

- **WHEN** the user presses Forget on a remote's credential card with no failed save shown
- **THEN** only the credential for the remote URL's username is forgotten

### Requirement: Helper saves use the username the remote URL already has

On the helper path, the saved credential's username and the remote URL's username MUST be identical. A remote's credential card MUST write both from the same value. The host-level helper form MUST save under the spelling an open repo's HTTPS remote URL uses for that host when the typed username differs from it only in case, and MUST say so.

#### Scenario: Case-only difference in the helper form

- **WHEN** the open repository's `origin` is `https://Siomkin@github.com/…` and the user saves `siomkin` in the helper form
- **THEN** the credential is saved for `Siomkin`, and the form says it used the remote's spelling

#### Scenario: Remote card

- **WHEN** the user saves a credential on a remote's card with the username `Siomkin`
- **THEN** the remote URL username and the saved credential's username are both `Siomkin`

### Requirement: A saved credential is checked against the remote right away

After a successful save, GitLane MUST check each HTTPS remote of the open repository on that host with the same transport auth a fetch would use, and report the result inline, per remote. If every checked remote rejects a GitLane-owned token as an authentication failure, GitLane MUST remove that token again. With no matching open remote, the form MUST say the credential was saved but not yet checked.

#### Scenario: Token works

- **WHEN** the user saves a valid token and the open repository's `origin` is on that host
- **THEN** the form reports that `origin` accepted it

#### Scenario: Token rejected

- **WHEN** the user saves a GitLane token and the check of `origin` fails as an authentication error
- **THEN** the form shows the remote's rejection, the token is no longer stored, and the token field still holds it for correction

#### Scenario: Network failure during the check

- **WHEN** the check cannot reach the remote
- **THEN** the form says the credential was saved but could not be checked, and keeps it

#### Scenario: No repository open

- **WHEN** the user saves a token with no repository open, or none of its remotes is on that host
- **THEN** the form says the credential was saved and will be used on the next fetch, without claiming it was verified

### Requirement: Fix authentication leads to a working GitHub remote without a terminal

For a GitHub authentication failure, the toast's "Fix authentication…" action MUST open Settings > Accounts on a GitHub token flow: paste the token, save, check. The username is prefilled from the failing repository's remote URL when it has one. Nothing in this flow MUST show or ask for a terminal command.

#### Scenario: Fetch fails for missing GitHub credentials

- **WHEN** a fetch from a github.com HTTPS remote fails with an authentication error and the user clicks "Fix authentication…"
- **THEN** Settings > Accounts opens on the GitHub token form, and after a valid token is saved the form reports that the remote accepted it

#### Scenario: No terminal instructions

- **WHEN** the GitHub token flow is opened from "Fix authentication…"
- **THEN** it shows no terminal command and no "Prefer the terminal?" disclosure

### Requirement: GitHub credentials are asked for as a personal access token

For a GitHub host, the secret field MUST be labelled as a personal access token (fine-grained or classic), not a password. A "Create a token" link MUST open that host's token settings. The credentials-missing hint for a GitHub remote MUST mention a personal access token.

#### Scenario: GitHub token form

- **WHEN** the user opens a GitHub token or helper form
- **THEN** the secret field reads as a personal access token, and "Create a token" opens GitHub's token settings

#### Scenario: Missing-credentials hint

- **WHEN** a fetch from a github.com HTTPS remote fails as `credentialsMissing`
- **THEN** the hint says GitHub needs a personal access token, not the account password

### Requirement: A github.com secret that does not look like a token gets a soft warning

On github.com only, a secret that does not start with `ghp_`, `github_pat_`, `gho_`, `ghu_`, or `ghs_` MUST show a warning that GitHub does not accept account passwords for Git. The warning MUST NOT disable or block saving. No warning MUST be shown for any other host.

#### Scenario: Password typed for github.com

- **WHEN** the user enters a secret without a known token prefix for `github.com`
- **THEN** a warning appears and Save stays enabled

#### Scenario: GitHub Enterprise Server

- **WHEN** the user enters a secret without a known prefix for a GitHub Enterprise Server host
- **THEN** no prefix warning appears and the secret saves normally
