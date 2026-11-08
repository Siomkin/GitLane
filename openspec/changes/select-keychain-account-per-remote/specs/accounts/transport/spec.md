# Spec Delta

## ADDED Requirements

### Requirement: A GitHub remote's account picker offers every account on its host

On a GitHub HTTPS remote, the account picker MUST list each signed-in `gh` account and each GitLane keychain token saved for that remote's host. Each entry MUST show its source, so two accounts with the same login are distinguishable. The picker MUST show the account that git transport will use for the remote. When there is only one possible choice, the picker MUST NOT appear, and the remote MUST show a note saying how it authenticates.

#### Scenario: A gh account and a keychain token share a login

- **WHEN** `gh` is signed in to github.com as `Octocat`, a keychain token is saved for github.com as `octocat`, and the user opens the account picker on a github.com HTTPS remote
- **THEN** the picker lists `@Octocat` marked as GitHub CLI and `@octocat` marked as Keychain token as separate choices

#### Scenario: A token saved for another host

- **WHEN** a keychain token is saved for a GitHub Enterprise host and the user opens the picker on a github.com remote
- **THEN** that token is not listed

#### Scenario: Only a keychain token exists

- **WHEN** a keychain token is saved for the remote's host and no `gh` account matches that host
- **THEN** no picker appears and the remote shows that it authenticates with a token stored in the OS keychain

#### Scenario: SSH remote

- **WHEN** the remote uses SSH and a keychain token is saved for its host
- **THEN** no picker appears and the remote shows that its account is selected by the SSH key

#### Scenario: Repository opened over SSH

- **WHEN** a repository opened over SSH has a GitHub HTTPS remote and this computer has a keychain token for that host
- **THEN** the picker does not list the token and the token is not shown as the account in use

### Requirement: Choosing a keychain token makes the remote authenticate with it

When the user chooses a keychain token in a GitHub remote's account picker, fetch, pull, and push on that remote MUST authenticate with that token, even when a signed-in `gh` account has the same login in any letter case. If the remote is the repository's default remote, pull requests MUST use the same token. The choice MUST NOT change the user's global `gh` state and MUST survive reopening the repository.

#### Scenario: Choosing a token whose login matches a gh account

- **WHEN** `origin` is bound to the `gh` account `Octocat`, a keychain token is saved as `octocat`, and the user chooses the keychain token and pushes
- **THEN** the push authenticates with the keychain token, and `gh auth status` reports the same active account as before

#### Scenario: Another token exists on the host

- **WHEN** a `gh` account and a keychain token share a login, a second keychain token was saved later for that host, and the user chooses the token sharing the login and fetches
- **THEN** the fetch and pull requests use the chosen token, and the picker still shows it

#### Scenario: A token saved after the choice

- **WHEN** a remote uses a keychain token whose login matches a `gh` account and the user saves another token for that host
- **THEN** the remote keeps using the chosen token

#### Scenario: Connecting another gh account

- **WHEN** a remote uses a keychain token and the user connects a new `gh` account from that remote's picker
- **THEN** the remote keeps using the keychain token

#### Scenario: The title bar names the chosen token

- **WHEN** the default GitHub remote uses a keychain token and the user opens the title bar's account card
- **THEN** the card names the token's account and does not say pull requests are off

#### Scenario: Pull requests follow the chosen token

- **WHEN** the user chooses a keychain token on the default remote and opens the pull requests view
- **THEN** pull requests are fetched with that token and the remote's summary shows the token's account

#### Scenario: Choosing a token whose login matches no gh account

- **WHEN** a keychain token is saved as `other`, no `gh` account on that host is named `other`, and the user chooses that token and fetches
- **THEN** the fetch authenticates with that token

#### Scenario: The choice survives reopening

- **WHEN** the user chooses a keychain token, closes the repository, and opens it again
- **THEN** the picker still shows the keychain token as the choice and transport still uses it

#### Scenario: Switching back to the gh account

- **WHEN** a remote uses a keychain token and the user chooses the `gh` account in the picker and pushes
- **THEN** the push authenticates as the `gh` account

#### Scenario: Signing out the chosen token

- **WHEN** a remote uses a keychain token and the user signs that token out in Settings > Accounts, leaving no other token for the host
- **THEN** the remote no longer shows the token as a choice and goes back to the user's own credential helpers

### Requirement: System git credentials is offered only when it would be used

The account picker MUST offer "System git credentials" on a GitHub HTTPS remote only when no keychain token is saved for that remote's host.

#### Scenario: No keychain token for the host

- **WHEN** the remote's host has a matching `gh` account and no keychain token
- **THEN** the picker offers "System git credentials" and the `gh` account

#### Scenario: A keychain token exists for the host

- **WHEN** the remote's host has a matching `gh` account and a keychain token
- **THEN** the picker offers the `gh` account and the keychain token, and does not offer "System git credentials"
