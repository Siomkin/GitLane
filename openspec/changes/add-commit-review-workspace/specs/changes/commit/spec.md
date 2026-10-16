# Spec Delta

## Purpose

Lets the user review every working-tree change against HEAD, choose exactly which files and
differences go into the next commit, revert or edit what does not belong, and commit — from one
surface whose selection is always the git index.

## ADDED Requirements

### Requirement: Inclusion is the git index

Every include checkbox in the commit review workspace SHALL reflect the git index, and toggling
one SHALL change the index immediately. GitLane MUST NOT keep a private inclusion selection, so
`git status` and `git diff --cached` in a terminal always match what the workspace shows.

#### Scenario: Checking a file stages it
- **WHEN** the user checks an unstaged modified file
- **THEN** the whole file is staged
- **AND** `git diff --cached --name-only` lists it

#### Scenario: Terminal staging shows up
- **WHEN** the user runs `git add` on a file in a terminal while the workspace is open
- **THEN** that file's checkbox becomes checked after the repository refresh, without user action

### Requirement: File checkboxes show partial inclusion

A file's checkbox SHALL be checked when all of its changes are staged, unchecked when none are,
and partly checked when some are. Checking a partly checked or unchecked file SHALL stage all of
its changes; unchecking a checked or partly checked file SHALL unstage all of them.

#### Scenario: One of two differences staged
- **WHEN** a file has two differences and only the first is staged
- **THEN** the file's checkbox shows the partly checked state

#### Scenario: Checking a partly included file
- **WHEN** the user checks a partly checked file
- **THEN** every change in that file is staged and the checkbox is checked

### Requirement: Include view shows one diff against HEAD

In the Include view, the selected file's diff SHALL compare HEAD with the working tree, split into
differences: each contiguous block of added, removed, or changed lines. Each difference SHALL show
an include checkbox with its state from the index, and the header SHALL show the number of
differences and how many are included.

#### Scenario: Two separate edits in one unstaged file
- **WHEN** the user edits lines 10 and 80 of a committed file and stages nothing
- **THEN** the diff shows two differences, both unchecked
- **AND** the header reads "2 differences, 0 included"

#### Scenario: A file staged and then edited further
- **WHEN** a staged change sits at line 10 and an unstaged change at line 80 of the same file
- **THEN** the Include view shows one HEAD-to-working-tree diff with the line 10 difference checked and the line 80 difference unchecked

### Requirement: Toggling a difference changes exactly its lines

Checking a difference SHALL stage exactly that difference's changes; unchecking it SHALL unstage
exactly them. No other difference in the file, staged or not, SHALL change, and the operation
SHALL follow the partial-staging guarantees of `changes/patch-staging`.

#### Scenario: Include the second of three differences
- **WHEN** a file has three unstaged differences and the user checks the second
- **THEN** only the second difference is staged
- **AND** the first and third remain unstaged and unchanged

#### Scenario: Exclude a staged difference
- **WHEN** the user unchecks a staged difference while another difference in the file stays staged
- **THEN** only the unchecked difference returns to unstaged

#### Scenario: Partly included difference
- **WHEN** some lines of one difference are staged and others are not, and the user checks it
- **THEN** the remaining lines of that difference are staged and the difference shows as checked

### Requirement: Staging-area view keeps staged and unstaged separate

The workspace SHALL offer a Staging-area view that shows a file's staged changes (HEAD to index)
and unstaged changes (index to working tree) as separate diffs with per-hunk and per-line stage
and unstage actions. Switching views SHALL NOT change the index or the working tree.

#### Scenario: Switch views on a partly staged file
- **WHEN** the user switches from the Include view to the Staging-area view on a partly staged file
- **THEN** the staged and unstaged changes are shown separately
- **AND** the index and working tree are unchanged

### Requirement: Excluded differences can be reverted

The Include view SHALL offer a revert action on each difference with no staged part. Reverting
SHALL restore that block of the working-tree file to its index content and leave every other part
of the file and the index unchanged. The action SHALL NOT be offered on a fully or partly included
difference, and SHALL say why.

#### Scenario: Revert one excluded difference
- **WHEN** a file has two unstaged differences and the user reverts the first
- **THEN** the working-tree file loses only the first difference
- **AND** the second difference and the index are unchanged

#### Scenario: Revert unavailable on an included difference
- **WHEN** the user hovers the revert control of a difference that is staged
- **THEN** the control is disabled and explains that the difference must be excluded first

#### Scenario: The file changed after the diff was shown
- **WHEN** the working-tree file changed on disk after the diff was rendered and the user reverts a difference
- **THEN** GitLane refuses, asks the user to refresh, and modifies nothing

### Requirement: The current version can be edited from the workspace

When the file is a text file whose line endings are all LF or all CRLF and the diff is not
truncated, its working-tree version SHALL be editable and savable from the workspace, and saving
SHALL keep the file's line-ending style. Saving SHALL refuse when the file changed on disk since it
was loaded. After saving, the diff and inclusion states SHALL refresh.

#### Scenario: Fix a line and save
- **WHEN** the user edits a line on the current side and saves
- **THEN** the working-tree file contains the edit and the diff shows it as an unstaged change

#### Scenario: CRLF file keeps its line endings
- **WHEN** the selected file uses CRLF line endings and the user adds a line and saves
- **THEN** every line of the saved file, including the new one, ends with CR LF

#### Scenario: Mixed line endings are read-only
- **WHEN** the selected file mixes CRLF and LF line endings
- **THEN** the file opens read-only and explains why

#### Scenario: Conflicting save
- **WHEN** the file was changed by another program after it was loaded and the user saves
- **THEN** the save is refused and the user is asked to reload

### Requirement: Differences and files can be navigated from the keyboard

The workspace SHALL let the user move to the previous and next difference in the selected file and
to the previous and next changed file, by toolbar controls and keyboard shortcuts, and SHALL show
the selected file's position in the changed-file list.

#### Scenario: Next difference at the end of a file
- **WHEN** the selected difference is the last one in the file and the user moves to the next difference
- **THEN** the selection moves to the first difference of the next changed file

#### Scenario: Position indicator
- **WHEN** the fifth of seventeen changed files is selected
- **THEN** the toolbar shows "5/17 files"

### Requirement: Commit from the workspace

The workspace SHALL include the commit composer — message, amend, identity, and the commit / commit
and push actions — and SHALL commit exactly the staged content. Committing with nothing included
SHALL be refused unless amending.

#### Scenario: Commit the included differences
- **WHEN** one of two differences in a file is included and the user commits
- **THEN** the commit contains only that difference
- **AND** the other difference remains as an unstaged change

#### Scenario: Nothing included
- **WHEN** no file or difference is included and amend is off
- **THEN** the commit action is disabled and says nothing is included

### Requirement: The Include diff can show the whole file

The Include diff SHALL offer a whole-file mode that shows every line of the file instead of
hunks with three lines of context, with no hunk headers. In that mode every difference SHALL keep
its include checkbox, revert action, navigation, and count. When the file is too large to show
whole, the diff SHALL fall back to hunks and say so.

#### Scenario: Whole file with three differences
- **WHEN** the user turns on whole-file mode for a 30-line file with three separate edits
- **THEN** all 30 lines are shown with no hunk headers
- **AND** the header still reads "3 differences, 0 included" and each difference keeps its checkbox

#### Scenario: Include a difference in whole-file mode
- **WHEN** the user checks the second difference in whole-file mode
- **THEN** exactly that difference is staged, as in hunk mode

#### Scenario: File too large for whole-file mode
- **WHEN** whole-file mode is on for a file longer than the display limit
- **THEN** the diff shows hunks and explains that the file is too large to show whole

### Requirement: The split Include diff labels its sides

In split mode the Include diff SHALL label the left side as HEAD with its short commit id and the
right side as the working tree.

#### Scenario: Side labels
- **WHEN** the user views a file's Include diff in split mode
- **THEN** the left column is headed "HEAD" with the short commit id and the right column "Working tree"

