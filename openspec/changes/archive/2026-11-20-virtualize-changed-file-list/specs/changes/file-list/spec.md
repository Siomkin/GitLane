# Spec Delta

## Purpose

Keeps the changed-files lists in the right-hand inspectors (Working Changes,
the selected commit, and a merged selection) complete and responsive, however
many files a change touches.

## ADDED Requirements

### Requirement: Large file lists stay responsive

The changed-files list SHALL keep scrolling, row selection, and re-rendering
responsive when a section holds thousands of files, in both Path and Tree view.
The list SHALL keep in the page only the rows near the visible area, not one
element per file.

#### Scenario: Thousands of untracked files

- **GIVEN** a working tree with 7,500 untracked files spread over thousands of directories
- **WHEN** the user opens the Working Changes inspector in Tree view and scrolls through the Unstaged section
- **THEN** the panel scrolls without visible stalls
- **AND** the page holds only the rows near the visible area, not 7,500 file rows

#### Scenario: Re-sync after an outside change

- **GIVEN** the inspector shows a section with thousands of files
- **WHEN** a change outside the app triggers a working-tree re-sync
- **THEN** the panel updates without freezing the window

### Requirement: Every file stays reachable

The changed-files list SHALL NOT cap or truncate its files. Every file and every
Tree-view folder SHALL stay reachable by scrolling. Section counts, the filter,
folder collapse, and the Stage/Unstage controls SHALL behave as they do for a
short list.

#### Scenario: Scroll to the last file

- **GIVEN** a section with thousands of files
- **WHEN** the user scrolls to the bottom of the inspector
- **THEN** the last file of the section is shown and can be selected

#### Scenario: Sections share one scroll

- **GIVEN** the Working Changes inspector shows both an Unstaged and a Staged section with many files each
- **WHEN** the user scrolls the inspector
- **THEN** the header, the Unstaged section and the Staged section scroll together as one page, as they do today

#### Scenario: Folder Stage action in a large tree

- **GIVEN** a Tree-view section with thousands of files
- **WHEN** the user stages a folder from its header
- **THEN** exactly the files under that folder are staged
- **AND** the folder action is still disabled, with its reason, when a file under it is guarded

### Requirement: Keyboard navigation reaches off-screen rows

Arrow-key navigation in the changed-files list SHALL move the selection to the
next or previous visible file and bring that row into view, even when the row
was outside the rendered area.

#### Scenario: Arrow down past the visible rows

- **GIVEN** a long list with the last visible row selected
- **WHEN** the user presses ↓
- **THEN** the next file is selected
- **AND** the list scrolls so that file's row is visible
