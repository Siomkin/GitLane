## MODIFIED Requirements

### Requirement: A slow checkout shows a progress indicator

While a branch, remote-branch, or detached checkout is running, GitLane SHALL show a progress card that names the target, if the checkout has not finished within a short delay. The checkout counts as running from the user's gesture until the history shows the result: the check for a worktree that holds the branch, the git command, and the refresh of the repository afterwards. The card SHALL disappear when the checkout has finished, failed, or handed off to a dialog. A checkout that finishes within the delay SHALL show no card.

#### Scenario: Checkout blocked by a slow hook
- **WHEN** the user double-clicks the `origin/develop` ref pill and the repository's `post-checkout` hook takes 10 seconds
- **THEN** a progress card reading "Checking out develop…" is visible while the hook runs
- **AND** the card is gone once the checkout returns and the history has refreshed

#### Scenario: Slow refresh after a fast git checkout
- **WHEN** git switches branches immediately but reloading the history afterwards takes 3 seconds
- **THEN** the progress card stays visible until the refreshed history is shown

#### Scenario: Fast checkout
- **WHEN** a checkout, including its refresh, completes within the delay
- **THEN** no progress card appears

## ADDED Requirements

### Requirement: The ref being checked out shows that it is pending

From the user's checkout request until it finishes, fails, or hands off to a dialog, the ref pill the user acted on SHALL show a pending indicator in place of its icon, marked busy for assistive technology, whichever way the checkout was started. The indicator SHALL appear immediately and only in the repository where the checkout runs.

#### Scenario: Double-clicking a remote ref
- **WHEN** the user double-clicks the `origin/develop` pill
- **THEN** the `origin/develop` pill shows a spinner at once
- **AND** the spinner is gone when `develop` is shown as checked out

#### Scenario: Checkout fails
- **WHEN** a checkout of `feature/x` is refused because of local changes
- **THEN** the `feature/x` pill stops showing the spinner and the error toast appears

#### Scenario: Branch is held by another worktree
- **WHEN** the checkout opens the "Branch is in another worktree" dialog
- **THEN** the pill stops showing the spinner while the dialog is open

#### Scenario: Switching tabs mid-checkout
- **WHEN** the user switches to another repository tab while a checkout is running in the first
- **THEN** no pill in the second repository shows a spinner

#### Scenario: Ref pill combined with its remote
- **WHEN** `develop` and `origin/develop` are drawn as one combined pill and either is being checked out
- **THEN** the combined pill shows the spinner

### Requirement: A second checkout is refused while one runs

While a checkout is pending in a repository, another checkout request in that repository SHALL NOT run git, and nothing chained after it SHALL run. A repeated double-click on a ref pill SHALL be dropped without an error; a request from a menu SHALL report that a checkout is already running. Requests in other repositories are unaffected.

#### Scenario: Repeated double-click
- **WHEN** the user double-clicks `origin/develop` and double-clicks it again before the first checkout finishes
- **THEN** git's checkout runs once

#### Scenario: Different ref while one is pending
- **WHEN** a checkout of `develop` is pending and the user double-clicks `main`
- **THEN** nothing happens for `main`, and `develop`'s checkout completes as normal

#### Scenario: Menu action that checks out first
- **WHEN** a checkout is pending and the user picks a drag-and-drop action that checks out a remote branch and then rebases
- **THEN** an error says a checkout is already running, and neither the checkout nor the rebase runs
