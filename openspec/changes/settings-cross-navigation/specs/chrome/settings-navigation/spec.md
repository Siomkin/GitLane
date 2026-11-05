# Spec Delta

## Purpose

Defines how the global App settings window and the repo-scoped Repository settings window link to each other. It covers connecting an account for a remote, returning to the repository afterwards, and dismissing the inline commit-identity picker without changing anything.

## ADDED Requirements

### Requirement: Remote offers a connect-account action
In Repository settings, each HTTPS remote whose provider GitLane can connect SHALL offer an action that opens App settings → Accounts on that provider's connect view. The action reads "Connect <Provider> account…" when no account matches the remote. When the remote shows an account dropdown, it reads "Connect another…".

#### Scenario: GitHub remote with no matching account
- **GIVEN** a repository whose `origin` is an HTTPS github.com remote and no connected GitHub account for that host
- **WHEN** the user clicks "Connect GitHub account…" on `origin`'s Account row
- **THEN** Repository settings closes and App settings opens on Accounts with the GitHub connect view showing

#### Scenario: Remote that already has accounts to choose from
- **GIVEN** an HTTPS github.com remote showing an account dropdown
- **WHEN** the user clicks "Connect another…"
- **THEN** App settings opens on Accounts with the GitHub connect view showing

#### Scenario: SSH or unsupported remote
- **WHEN** a remote uses an SSH URL, or its host belongs to a forge GitLane cannot connect
- **THEN** its Account row shows the existing explanatory note and no connect action

### Requirement: App settings returns to the repository it was opened from
When App settings was opened by a remote's connect action, it SHALL show a "← Back to <repo>" link. The link closes App settings and opens Repository settings on the remotes section. Closing App settings any other way SHALL drop the return target without reopening anything.

#### Scenario: Back after connecting
- **GIVEN** App settings opened from `origin`'s connect action in repository `Siomkin/Cadence`
- **WHEN** the user clicks "← Back to Siomkin/Cadence"
- **THEN** App settings closes and Repository settings opens scrolled to Remotes

#### Scenario: Plain close
- **GIVEN** App settings opened from a remote's connect action
- **WHEN** the user closes App settings with ✕ or Escape
- **THEN** no settings window remains open, and a later App settings open shows no Back link

#### Scenario: Opened normally
- **WHEN** App settings is opened from the toolbar or a menu
- **THEN** no Back link is shown

### Requirement: A newly connected account is bound on return
On returning through the Back link, if the originating remote had no bound account and exactly one account that matches the remote's host has appeared since the hand-off, that account SHALL be bound to the remote. Otherwise the remote's binding SHALL be left unchanged.

#### Scenario: One new matching account
- **GIVEN** an unbound github.com remote, and the user connects one new github.com account from its connect action
- **WHEN** the user returns through the Back link
- **THEN** the remote's Account shows the new account

#### Scenario: Remote already bound
- **GIVEN** a remote bound to `@alice`, and the user connects `@bob` through "Connect another…"
- **WHEN** the user returns through the Back link
- **THEN** the remote stays bound to `@alice` and `@bob` is offered in the dropdown

#### Scenario: Nothing connected
- **WHEN** the user returns without connecting an account
- **THEN** the remote's binding is unchanged

### Requirement: App settings links to the open repository's settings
When a repository is open, the App settings sidebar SHALL show a "This repository" entry naming the repository. The entry closes App settings and opens Repository settings. With no repository open, the entry SHALL be hidden.

#### Scenario: Repository open
- **GIVEN** repository `backend` is open
- **WHEN** the user clicks the `backend` entry under "This repository" in the App settings sidebar
- **THEN** App settings closes and Repository settings for `backend` opens

#### Scenario: No repository open
- **WHEN** App settings is open and no repository is open
- **THEN** the sidebar shows no "This repository" entry

### Requirement: The identity picker can be cancelled
The expanded commit-identity list in Repository settings SHALL offer a Cancel control. Cancel and Escape SHALL collapse the list and leave the repository's identity unchanged. Escape SHALL NOT close Repository settings while the list is expanded.

#### Scenario: Cancel button
- **GIVEN** the user clicked "Change" and the identity list is expanded with `Emedicus` selected
- **WHEN** the user clicks Cancel
- **THEN** the list collapses, `Emedicus` remains the commit identity, and no git config is written

#### Scenario: Escape
- **GIVEN** the identity list is expanded
- **WHEN** the user presses Escape
- **THEN** the list collapses and Repository settings stays open
- **AND** a second Escape closes Repository settings

### Requirement: The identity picker links to creating a new identity
The expanded commit-identity list SHALL offer a "New identity…" action that opens App settings → Identities with a new-identity editor.

#### Scenario: New identity
- **WHEN** the user clicks "New identity…" in the expanded list
- **THEN** Repository settings closes and App settings opens on Identities with an empty new-identity editor
