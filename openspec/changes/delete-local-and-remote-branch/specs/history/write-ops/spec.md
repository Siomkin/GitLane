## ADDED Requirements

### Requirement: The branch delete confirmation can also delete the remote counterpart

When a local branch can be deleted on its own and its upstream is a remote-tracking
branch that exists, the delete confirmation SHALL offer a checkbox that also deletes
that remote branch.

The checkbox SHALL name the remote branch and SHALL start unticked. Confirming with it
unticked SHALL delete only the local branch, exactly as before.

#### Scenario: Merged branch with a live upstream
- **WHEN** the user chooses `Delete feature` on local branch `feature`, which tracks
  `origin/feature`, and `origin/feature` exists
- **THEN** the confirmation shows an unticked "Also delete `origin/feature` on the
  remote" checkbox
- **AND** the Danger zone has no additional delete row

#### Scenario: Box ticked, both deleted
- **WHEN** the user ticks the box and confirms, and the remote and local deletes both
  succeed
- **THEN** `feature` and `origin/feature` disappear from the graph
- **AND** one message reports that both were deleted

#### Scenario: Box left unticked
- **WHEN** the user confirms without ticking the box
- **THEN** only `feature` is deleted and `origin/feature` is untouched

### Requirement: Ticking the remote checkbox states the shared consequence

While the remote checkbox is ticked, the dialog SHALL state that the remote delete
affects everyone using that remote and cannot be undone in GitLane, together with the
remote branch's own preview. The confirm button SHALL say that both branches will be
deleted. If the remote branch cannot be previewed, the checkbox SHALL NOT be offered.

#### Scenario: Box ticked
- **WHEN** the user ticks "Also delete `origin/feature` on the remote"
- **THEN** a warning names `origin` and says the delete affects everyone using it
- **AND** the confirm button reads `Delete both`

#### Scenario: Box unticked again
- **WHEN** the user unticks the box
- **THEN** the warning disappears and the confirm button reads `Delete branch`

### Requirement: The remote checkbox is only offered for a real remote counterpart

The checkbox SHALL NOT appear in any of these cases:

- the branch has no upstream;
- its upstream remote is `.`;
- its upstream branch has a different name from the local branch;
- the upstream's remote-tracking ref does not exist.

The branch-and-worktree delete dialog is out of scope and stays unchanged.

#### Scenario: No upstream
- **WHEN** the user deletes a local branch with no upstream
- **THEN** the confirmation has no remote checkbox

#### Scenario: Upstream already gone
- **WHEN** the branch's upstream `origin/feature` was pruned after the forge deleted it
- **THEN** the confirmation has no remote checkbox and the local delete works as before

#### Scenario: Upstream is a differently-named shared branch
- **WHEN** local `feature` tracks `origin/main` (for example after `git checkout -b feature origin/main`)
- **THEN** the confirmation has no remote checkbox, so `main` can never be deleted on the remote from here

#### Scenario: Upstream is another local branch
- **WHEN** the branch tracks a local branch (upstream remote `.`)
- **THEN** the confirmation has no remote checkbox

### Requirement: The combined delete removes the remote branch before the local one

With the box ticked, the delete SHALL remove the remote branch first, then the local
branch:

- The remote delete SHALL be leased to the remote-tracking ref's tip as previewed, not
  to the local branch's tip.
- The local branch SHALL be deleted only after the remote delete succeeds, leased to the
  previewed local tip.
- A remote branch that is already gone SHALL count as success.

#### Scenario: Remote delete fails
- **WHEN** the remote delete fails (authentication, network, or a moved remote branch)
- **THEN** the local branch is not deleted
- **AND** the message says that nothing was deleted and gives the remote's reason

#### Scenario: Remote already gone at confirm time
- **WHEN** the server no longer has `feature` when the user confirms
- **THEN** `origin/feature` is removed, the local branch is still deleted, and the
  message reports both

#### Scenario: Local delete fails after the remote delete
- **WHEN** the remote delete succeeds but the local delete fails, for example because
  `feature` moved since the preview
- **THEN** `origin/feature` stays deleted and `feature` stays
- **AND** one message names what was deleted, what was kept, and why

#### Scenario: Local branch ahead of its upstream
- **WHEN** local `feature` has commits that `origin/feature` does not have
- **THEN** the remote delete is leased to `origin/feature`'s tip, not to `feature`'s

### Requirement: The combined delete acts on the repository it was confirmed in

Both deletes SHALL run against the repository the confirmation was opened on. Switching
tabs or repositories while they run SHALL NOT retarget either delete.

#### Scenario: Repository switched mid-run
- **WHEN** the user confirms the combined delete in repository A and switches to
  repository B before the local delete starts
- **THEN** the local delete still targets repository A, or is refused with a message to
  preview again
- **AND** no branch in repository B is deleted

### Requirement: The delete dialog shows each step until the delete finishes

After the user confirms a branch delete, ticked or not, the dialog SHALL stay open
and show one row per step (remote when ticked, local, refresh), each marked pending,
running, done, or failed. On success it SHALL close itself shortly after the last row;
on failure it SHALL stay open with the message under the failed row.

#### Scenario: Unticked delete
- **WHEN** the user confirms "Delete branch" without the remote
- **THEN** the dialog shows the local and refresh rows, ticks them off, and closes itself

#### Scenario: Slow remote
- **WHEN** the user confirms "Delete both" and the push to the remote takes several seconds
- **THEN** the dialog stays open with "Delete origin/feature" running and the local and refresh rows pending
- **AND** once the remote answers, the local row runs, then the refresh row

#### Scenario: Remote step fails
- **WHEN** the remote delete fails
- **THEN** the dialog title reads "Nothing was deleted", the remote row is marked failed, and the later rows stay pending


### Requirement: Closing the delete dialog does not stop the delete

Closing the delete dialog mid-run SHALL NOT stop the delete. A failure that lands after
the dialog was closed SHALL be shown as a notification.

#### Scenario: Closed mid-run
- **WHEN** the user closes the dialog while the delete runs and the delete then fails
- **THEN** the failure appears as a notification

### Requirement: A partial-failure message keeps the failure's own explanation

The message for a failed step SHALL put what was and was not deleted above git's
explanation of the failure. It SHALL keep that failure's tailored wording and actions,
such as the index-lock text, a hook's reasons, the Accounts link for an authentication
failure, or the server-side fix for a repository opened over SSH.

#### Scenario: Local delete hits a stale index lock
- **WHEN** the remote delete succeeds and the local delete fails on `.git/index.lock`
- **THEN** the message first says `origin/feature` was deleted and `feature` was kept, then gives the index-lock explanation
