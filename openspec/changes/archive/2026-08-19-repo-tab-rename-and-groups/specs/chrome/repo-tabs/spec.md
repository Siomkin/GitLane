## Purpose

Defines how open repositories are identified in the app chrome: the display name each repository carries in the title-bar tab strip and the recent-repositories list, the user-defined groups that keep related repositories visually together, and the tab context menu that edits both.

## ADDED Requirements

### Requirement: Custom repository display name

A repository SHALL be able to carry a user-assigned display name that replaces the folder-derived label everywhere the repository is listed in the app chrome — the title-bar tab strip and the recent-repositories list. A repository with no assigned name SHALL continue to display its leaf directory name. The name SHALL apply to the repository identity, so a linked worktree of that repository displays the custom name in place of the parent repository's folder name.

#### Scenario: Renaming a repository

- **WHEN** the user assigns the display name "Acme · frontend" to a repository whose folder is `frontend`
- **THEN** its tab and its recent-repositories row both read "Acme · frontend"
- **AND** the repository's full path is still shown on hover and in the recents row's path line

#### Scenario: Worktree tab inherits the parent's name

- **WHEN** a linked worktree of a renamed repository is open
- **THEN** its tab reads `<custom name> · <branch>` instead of `<folder name> · <branch>`

#### Scenario: Clearing a custom name

- **WHEN** the user submits an empty display name for a renamed repository
- **THEN** the repository reverts to its folder-derived label

#### Scenario: No name assigned

- **WHEN** a repository has never been renamed
- **THEN** it displays its leaf directory name, exactly as before this capability existed

### Requirement: Repository groups

The system SHALL let the user create named groups, each with a colour, and assign a repository to at most one group. Assigning, reassigning, or removing a repository's group SHALL take effect immediately in the tab strip and the recents list. Group membership SHALL apply to the repository identity, so a repository's linked worktrees belong to the same group.

#### Scenario: Creating a group and assigning a repository

- **WHEN** the user creates the group "Acme" and assigns the open repository to it
- **THEN** that repository is shown as a member of "Acme" in the tab strip and under an "Acme" heading in the recents list

#### Scenario: Reassigning a repository

- **WHEN** a repository already in group "Acme" is assigned to group "Personal"
- **THEN** it leaves "Acme" and appears only under "Personal"

#### Scenario: Removing a repository from its group

- **WHEN** the user removes a repository from its group
- **THEN** it is shown as ungrouped, and its custom display name (if any) is unchanged

#### Scenario: Empty group

- **WHEN** the last repository leaves a group
- **THEN** the group still exists and remains offered when assigning another repository

### Requirement: Grouped tab strip

The tab strip SHALL draw the tabs of a group contiguously inside a visually bounded cluster — a tinted well — preceded by the group's name and a divider separating it from the tabs, so an ungrouped tab drawn beside a group is never mistaken for a member of it. The name SHALL be drawn desaturated rather than in the group's colour, so a group never outranks the active tab; the colour identifies the group where a swatch is used (the group menus and the recent-repository sections). A group's cluster SHALL be positioned at the first of its members in the user's tab order, and the relative order of tabs within a group SHALL follow the user's tab order. Ungrouped tabs SHALL render as they do today, with no chip and no cluster.

#### Scenario: Group members are drawn together

- **GIVEN** tabs ordered `frontend (Acme)`, `notes (ungrouped)`, `backend (Acme)`
- **WHEN** the tab strip renders
- **THEN** the "Acme" cluster is drawn at the position of `frontend`, holding the chip, `frontend`, and `backend`, and `notes` is drawn outside that cluster, after it

#### Scenario: Distinguishing same-named repositories

- **GIVEN** three open repositories all named `frontend`, in three different groups
- **WHEN** the tab strip renders
- **THEN** each tab sits in its own group's well behind that group's name, so the three are distinguishable without hovering

#### Scenario: Dragging a group

- **WHEN** the user drags a group by its well (its name, or any part of the cluster no tab owns)
- **THEN** the whole group moves as one piece, its tabs travelling with it, and the new order is persisted

#### Scenario: Reordering tabs

- **WHEN** the user drags a tab
- **THEN** it can be reordered only within its own group (an ungrouped tab among the other ungrouped tabs and groups), and the new order is persisted
- **AND** the drag never changes any tab's group membership: a tab has no valid drop position inside a group it does not belong to

#### Scenario: Changing membership

- **WHEN** the user wants a repository in a different group
- **THEN** they assign it from the tab's context menu — dragging is not a way to join or leave a group

### Requirement: Grouped recent-repositories list

The recent-repositories list SHALL render one section per group that has at least one entry in the list, each under a heading carrying the group's name and colour, with ungrouped entries in a final section. Within every section, entries SHALL keep the existing most-recently-opened-first order.

#### Scenario: Sections in the recents list

- **GIVEN** recent repositories in groups "Acme" and "Personal" plus two ungrouped ones
- **WHEN** the start screen renders
- **THEN** the list shows an "Acme" section, a "Personal" section, and an ungrouped section last, each ordered most-recent-first

#### Scenario: A worktree entry sits with its repository

- **GIVEN** a recent entry for a linked worktree of a repository that has a custom name and a group
- **WHEN** the start screen renders
- **THEN** the entry appears in that repository's section under that custom name, the same identity its tab resolves to

#### Scenario: No groups defined

- **WHEN** no groups exist
- **THEN** the recents list renders as one ungrouped list with no headings, exactly as before this capability existed

### Requirement: Repository tab context menu

Right-clicking a repository tab SHALL open a menu offering, at minimum: renaming the repository, assigning it to an existing group, creating a new group with the repository as its first member, removing it from its group, and closing the tab. Actions that do not apply SHALL be hidden — "Remove from group" for an ungrouped repository, and the repository's current group in the assign list.

#### Scenario: Opening the menu

- **WHEN** the user right-clicks a repository tab
- **THEN** a menu opens at the pointer offering Rename…, group assignment, and Close

#### Scenario: Renaming from the menu

- **WHEN** the user chooses Rename… and submits a new name
- **THEN** the tab label updates immediately without reloading the repository

#### Scenario: Ungrouped repository

- **WHEN** the menu opens on a repository that belongs to no group
- **THEN** no "Remove from group" action is offered

#### Scenario: Menu exclusivity

- **WHEN** the tab menu opens while another context menu is open
- **THEN** the other menu closes, and only one menu is open at a time

### Requirement: Names and groups persist independently of recents

Custom names and group definitions/membership SHALL survive app restart and SHALL NOT be lost when the recent-repositories list is cleared, when an entry ages out of the recents cap, or when a repository's tab is closed. They SHALL be stored locally on the machine and SHALL NOT modify the repository on disk or its git configuration.

#### Scenario: Surviving a restart

- **WHEN** the user renames and groups repositories, quits, and reopens the app
- **THEN** the names, groups, and memberships are unchanged

#### Scenario: Clearing recents

- **WHEN** the user clears the recent-repositories list and later reopens one of those repositories
- **THEN** it reappears with its custom name and group intact

#### Scenario: Repository is untouched

- **WHEN** a repository is renamed or grouped
- **THEN** no file inside the repository, including its git configuration, is modified

#### Scenario: Missing or corrupt stored preferences

- **WHEN** the stored names/groups cannot be read or parsed
- **THEN** the app renders folder-derived labels with no groups rather than failing to start
