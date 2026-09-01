## Purpose

Lets a selected stash show every file git stored in that snapshot — tracked worktree edits, index-only edits, and untracked files — so inspect, review, and restore match what apply would put back.

## ADDED Requirements

### Requirement: Stash file list includes the full stored snapshot

When the user selects a stash, GitLane MUST list every path that applying that stash would restore. The list MUST include tracked worktree changes against the stash base, paths present only in the stash index parent, and untracked files stored on the optional third parent. A stash created without untracked files MUST still list its tracked (and index-only) paths. Ordinary commits MUST keep first-parent-only file lists.

#### Scenario: Untracked file stored in the stash appears in the inspector
- **WHEN** the user selects a stash that captured a modified tracked file and an untracked file
- **THEN** the changed-files list includes both paths and the count includes both

#### Scenario: Stash without a third parent stays tracked-only
- **WHEN** the user selects a stash that has no untracked parent
- **THEN** the list still shows the tracked snapshot and does not invent untracked rows

#### Scenario: Index-only path is listed
- **WHEN** the user selects a stash whose index parent differs from the base on a path that the worktree parent does not
- **THEN** that path appears in the changed-files list

#### Scenario: Inspecting a normal commit is unchanged
- **WHEN** the user selects a non-stash commit, including a merge commit
- **THEN** the file list remains the diff against that commit's first parent

### Requirement: Stash untracked files are reviewable as untracked

Untracked paths that belong to a stash MUST use the untracked status the working-tree list already uses. Opening the file MUST show the stored contents as an addition against an empty base. Stacked review of that stash MUST include those paths.

#### Scenario: Untracked stash file opens as a full addition
- **WHEN** the user opens an untracked path from a selected stash
- **THEN** the diff shows the stored file as added content and the file is marked untracked

#### Scenario: Review all includes untracked stash files
- **WHEN** the user starts stacked review from a stash whose snapshot includes untracked paths
- **THEN** those paths appear in the review alongside the tracked changes

### Requirement: Restore from a stash uses the snapshot that stored the path

Restoring a path from a selected stash MUST write the blob git stored for that path, including when the path exists only on the untracked parent. GitLane MUST NOT fail solely because the path is absent from the stash worktree tree. Restore of a tracked stash path MUST keep current worktree-only (not staged) behavior.

#### Scenario: Restore an untracked stash file
- **WHEN** the user restores a path that the selected stash stored only as untracked
- **THEN** the worktree contains that file's stashed contents and the path is not staged by the restore

#### Scenario: Restore a tracked stash file
- **WHEN** the user restores a tracked path from a selected stash
- **THEN** the worktree matches the stash worktree blob for that path and the restore does not stage it
