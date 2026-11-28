## Purpose

Defines the "New pull request" dialog: how it opens from every entry point, what its title starts as, and which account it says it will open the pull request as, on every forge GitLane can create pull requests on.

## Requirements

### Requirement: Create-PR dialog opens on token-authenticated forges

The "New pull request" dialog SHALL open and stay interactive on every forge where GitLane can create pull requests. That includes forges whose PR account resolves to a GitLane-owned keychain token: Bitbucket, and GitLab when glab cannot serve the host. Opening the dialog SHALL NOT freeze, blank or reload the window.

#### Scenario: Bitbucket repository with a stored token

- **WHEN** the open repository's forge is Bitbucket, a Bitbucket token is stored for its host, and the user chooses "Open a pull request…" on a branch
- **THEN** the dialog opens with that branch as the head, and the rest of the window stays rendered and responsive

#### Scenario: GitLab repository with a stored token and no glab

- **WHEN** the open repository's forge is GitLab, glab cannot serve its host, a GitLab token is stored for the host, and the user opens the dialog from the PR list's "New PR"
- **THEN** the dialog opens and stays interactive

#### Scenario: Typing in the open dialog

- **WHEN** the dialog is open on a token-authenticated forge and the user types a title
- **THEN** each keystroke shows in the field and the window stays responsive

### Requirement: Create-PR title defaults to the head's last commit subject

When the dialog opens, its title SHALL start as the subject line of the newest commit the pull request would carry, which is the head branch's last commit. The title SHALL be filled at most once per opening. It SHALL NOT replace text the user has typed, and SHALL NOT be refilled after the user clears it. If the pull request would carry no commits, the title SHALL stay empty.

#### Scenario: Title filled from the last commit

- **WHEN** the user opens the dialog for branch `feature/x`, whose newest commit is "Add profile tab" and which is ahead of the base
- **THEN** the title field shows "Add profile tab" once the commits have loaded, and the field can still be edited

#### Scenario: User typed before the commits loaded

- **WHEN** the user types "WIP: profile" into the title before the commits finish loading
- **THEN** the title stays "WIP: profile" after they load

#### Scenario: User cleared the prefilled title

- **WHEN** the title was prefilled and the user deletes it all
- **THEN** the title stays empty, including after the base is changed

#### Scenario: Nothing to merge

- **WHEN** the head branch has no commits that the base lacks
- **THEN** the title stays empty

### Requirement: Create-PR dialog names the account it opens as

When the repository's PR account is known, the dialog SHALL show the login it will open the pull request as and the host it belongs to. Changes to the stored account while the dialog is open SHALL update that label. Account secrets SHALL NOT appear in the dialog.

#### Scenario: Token account shown

- **WHEN** the dialog opens on a Bitbucket repository whose stored API token authenticates as username `alice` on `bitbucket.org`
- **THEN** the dialog shows "Opening as alice" and names `bitbucket.org` as the host

#### Scenario: No account resolved

- **WHEN** the dialog opens and no PR account resolves (for example GitLab served by glab, or Cursor Origin)
- **THEN** the dialog opens without an "Opening as" label

### Requirement: Auto-publishing a PR head matches the pull request target repository

When opening a pull request from a head branch that is unpublished or covered by the mismatched-upstream namesake publish rule, GitLane MUST publish only to a configured remote whose effective push URL matches the resolved PR repository. If no remote matches or the branch publishes to a different repository (unsupported cross-repository head), GitLane MUST disable creation, MUST NOT publish or submit a bare head, and MUST explain why inline.

#### Scenario: Mismatched-upstream branch on the PR target repository auto-publishes its own name

- **WHEN** the resolved PR repository matches remote `origin`, `feat/mcp-apps-subscriptions` tracks `origin/develop`, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** the dialog indicates it will publish to `origin/feat/mcp-apps-subscriptions`
- **AND** submitting publishes `feat/mcp-apps-subscriptions` to `origin/feat/mcp-apps-subscriptions` before creating the pull request

#### Scenario: Branch targets a different remote than the resolved PR repository

- **WHEN** the resolved PR repository matches remote `upstream`, `feat/mcp-apps-subscriptions` tracks `origin/develop` (or pushes to `origin` in a fork workflow), and `upstream/feat/mcp-apps-subscriptions` does not exist
- **THEN** the dialog disables pull request creation and explains that cross-repository pull requests are not supported
- **AND** GitLane does not publish to `origin` or `upstream` and does not submit a pull request

#### Scenario: Resolved PR repository has no matching configured remote

- **WHEN** the resolved PR repository (for example via `gh repo set-default`) does not match any configured remote's push URL and the head branch needs publishing
- **THEN** the dialog disables pull request creation and explains that cross-repository pull requests are not supported
- **AND** GitLane does not publish the branch or submit a pull request

#### Scenario: Same-repository remote alias is accepted for Create PR

- **WHEN** both `origin` and `mirror` push to the resolved PR repository and an unpublished branch is configured to push to `mirror`
- **THEN** the dialog allows auto-publishing to `mirror/<head>` and creating the pull request instead of blocking it as a cross-repository head

#### Scenario: The effective push destination changed after the dialog resolved the repository

- **WHEN** Git resolves an effective push URL outside the repository shown by the dialog
- **THEN** GitLane stops before publishing and explains the destination mismatch, including when HTTP(S) endpoints differ by effective port

#### Scenario: Publishing changes the repository selected by the forge

- **WHEN** publishing succeeds but the forge subsequently resolves a different repository from the one verified for publishing
- **THEN** GitLane does not submit the pull request and explains that the repository changed
- **AND** the open dialog retains the originally verified repository for subsequent attempts
