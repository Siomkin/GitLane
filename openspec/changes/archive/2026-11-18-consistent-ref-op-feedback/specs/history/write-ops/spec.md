## ADDED Requirements

### Requirement: A ref being written shows that it is pending

While a branch delete, rename, push, publish or force-push, or a tag delete or push, runs, each affected ref pill SHALL show a pending indicator in place of its icon, marked busy for assistive technology. It SHALL show from the request until the write finishes or fails, only in that repository. A pending ref write SHALL NOT cause a checkout to be refused.

#### Scenario: Deleting a branch on the remote
- **WHEN** the user confirms "Delete feature/x on remote"
- **THEN** the `origin/feature/x` pill shows a spinner as soon as the confirm dialog closes
- **AND** the pill is gone once the delete finishes and the graph refreshes

#### Scenario: Deleting a local branch and its remote counterpart
- **WHEN** the user deletes `feature/x` with "Also delete origin/feature/x" ticked
- **THEN** both the `feature/x` and the `origin/feature/x` pills show a spinner until the delete finishes

#### Scenario: Closing the delete dialog mid-run
- **WHEN** the user closes the branch delete dialog while the delete still runs
- **THEN** the `feature/x` pill keeps showing the spinner until the delete finishes or fails

#### Scenario: The write fails
- **WHEN** pushing `feature/x` from its menu fails with an authentication error
- **THEN** the `feature/x` pill stops showing the spinner and the error notification appears

#### Scenario: Deleting a tag on the remote
- **WHEN** the user deletes tag `v1.2` from local and `origin`
- **THEN** the `v1.2` tag pill shows a spinner until both deletes finish

#### Scenario: Combined local and remote pill
- **WHEN** `feature/x` and `origin/feature/x` are drawn as one combined pill and either ref is being written
- **THEN** the combined pill shows the spinner

#### Scenario: Switching tabs mid-write
- **WHEN** the user switches to another repository tab while a push runs in the first
- **THEN** no pill in the second repository shows a spinner

#### Scenario: Checking out while a push runs
- **WHEN** a push of `feature/x` is running and the user double-clicks the `main` pill
- **THEN** the checkout of `main` starts and is not refused because of the push

### Requirement: The branch-and-worktree delete dialog closes itself on success

When "Delete ‹branch› & worktree" succeeds, the dialog SHALL show every step as done and then close itself after a short pause, in the same way as the branch delete dialog. It SHALL NOT switch to a separate success screen. A failure SHALL keep the dialog open with the failure's explanation and a Close button.

#### Scenario: Routine success
- **WHEN** the user deletes `feature/x` and its worktree and both steps succeed
- **THEN** the dialog ticks off its rows and closes itself without showing a "Deleted feature/x" screen

#### Scenario: Failure
- **WHEN** removing the worktree fails
- **THEN** the dialog stays open, shows why, and offers a Close button

### Requirement: A delete that succeeds with a caveat still reports it

When the branch delete dialog or the branch-and-worktree delete dialog closes itself after a delete that succeeded but reported a caveat, the caveat SHALL be shown as a warning notification. One example is local branch settings that could not be removed. A routine success SHALL stay silent.

#### Scenario: Branch settings left behind
- **WHEN** deleting `feature/x` succeeds but its local branch settings could not be removed
- **THEN** the dialog closes itself and a warning notification states that the settings were not removed and why

#### Scenario: Routine success
- **WHEN** deleting `feature/x` succeeds with nothing to report
- **THEN** the dialog closes itself and no notification appears

### Requirement: A result screen that stays open can be closed with a button

A step dialog that stays open after it finishes SHALL offer a Close button. Examples are a detached-worktree removal with a partial failure and a finished hand-off. A detached-worktree removal in which every worktree was removed SHALL close itself after a short pause, like the delete dialogs.

#### Scenario: Partial failure removing detached worktrees
- **WHEN** two of three detached worktrees are removed and one fails
- **THEN** the dialog stays open with the per-row results and a Close button

#### Scenario: All detached worktrees removed
- **WHEN** every selected detached worktree is removed
- **THEN** the dialog ticks off its rows and closes itself

#### Scenario: Hand-off finished
- **WHEN** a hand-off finishes and the dialog shows where the work went
- **THEN** the dialog offers a Close button
