## Purpose

Defines how open repositories are identified in the app chrome: the display name each repository carries in the title-bar tab strip and the recent-repositories list, the user-defined groups that keep related repositories visually together, and the tab context menu that edits both.

## Requirements

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
- **THEN** that repository is shown as a member of "Acme" in the tab strip and carries the "Acme" colour dot in the recents list

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

The tab strip SHALL draw the tabs of a group contiguously inside a visually bounded cluster — a tinted well — preceded by the group's name and a divider separating it from the tabs, so an ungrouped tab drawn beside a group is never mistaken for a member of it. The name SHALL be drawn desaturated rather than in the group's colour, so a group never outranks the active tab; the colour identifies the group where a swatch is used (the group menus and the recent-repository dots). A group's cluster SHALL be positioned at the first of its members in the user's tab order, and the relative order of tabs within a group SHALL follow the user's tab order. Ungrouped tabs SHALL render as they do today, with no chip and no cluster.

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

### Requirement: Recent-repositories list keeps recency order

The recent-repositories list SHALL stay one list ordered most-recently-opened-first; groups SHALL NOT split or reorder it. A row whose repository belongs to a group SHALL show that group's colour dot beside its name, labelled with the group's name for assistive technology.

#### Scenario: Grouped entries stay in recency order

- **GIVEN** recent repositories `frontend (Acme)`, `notes (ungrouped)`, `backend (Acme)`, most recent first
- **WHEN** the start screen renders
- **THEN** the list reads `frontend`, `notes`, `backend` with no section headings
- **AND** `frontend` and `backend` each carry the "Acme" colour dot

#### Scenario: A worktree entry carries its repository's group

- **GIVEN** a recent entry for a linked worktree of a repository that has a custom name and a group
- **WHEN** the start screen renders
- **THEN** the entry shows that custom name and that group's dot, the same identity its tab resolves to

#### Scenario: No groups defined

- **WHEN** no groups exist
- **THEN** the recents list shows no dots and no headings

### Requirement: Remove one recent repository

Each recent-repositories row SHALL offer a remove control, shown on hover or keyboard focus in place of the row's last-opened time, that drops only that entry from the list without opening it. The repository on disk SHALL be untouched.

#### Scenario: Removing an entry

- **WHEN** the user activates the remove control on the `notes` row
- **THEN** `notes` leaves the recents list and the other entries keep their order
- **AND** the repository is not opened

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

### Requirement: Collapsing a group

A repository group SHALL be collapsible. A collapsed group SHALL be drawn as a single pill carrying a chevron, the group's name, and the number of tabs it holds, in place of its well and its tabs. An expanded group SHALL be drawn as its well, as specified by "Grouped tab strip".

Collapsing SHALL be a single click of the group's name and expanding a single click of the collapsed pill — one gesture in both directions, matching the pointer cursor both show. The pill is one control end to end; nothing inside it is separately clickable. A press that becomes a drag SHALL NOT toggle a group on release. Only the first click of a multi-click SHALL toggle, so a double-click toggles once rather than collapsing and re-expanding. Keyboard activation of the pill SHALL still toggle. The expanded well SHALL carry no other collapse control, so it stays exactly as "Grouped tab strip" specifies.

A group's collapsed state SHALL persist with the user's other view preferences, so a collapsed workspace survives quitting and reopening the app. Collapsing SHALL NOT change any tab's group membership, the stored tab order, or which repository is active.

#### Scenario: Collapsing a group

- **GIVEN** an expanded group "Acme" holding three tabs, none of them active
- **WHEN** the user clicks the group's name (or picks "Collapse group" from the group's context menu)
- **THEN** the group's well and its three tabs are replaced by one pill reading "Acme" with a count of 3, behind a chevron

#### Scenario: Expanding a group

- **GIVEN** a collapsed group
- **WHEN** the user clicks its pill (or picks "Expand group" from the group's context menu)
- **THEN** its well is drawn again with all of its tabs, in the order they had before it was collapsed

#### Scenario: A double-click toggles once

- **GIVEN** an expanded group "Acme"
- **WHEN** the user double-clicks the group's name
- **THEN** the group is collapsed, and the second click, landing on the new pill, does not expand it again

#### Scenario: Dragging a group does not toggle it

- **GIVEN** a collapsed group "Acme"
- **WHEN** the user presses on its pill, drags it to a new position, and releases it
- **THEN** the group is moved and is still collapsed

#### Scenario: Collapsed state outlives the session

- **GIVEN** a collapsed group
- **WHEN** the user quits and reopens the app
- **THEN** the group is still collapsed

#### Scenario: The group menu names the state it will move to

- **GIVEN** the context menu of a group
- **WHEN** it opens
- **THEN** it offers "Collapse group" while the group is expanded and "Expand group" while it is collapsed

### Requirement: Group actions have their own menu

Right-clicking a repository group — its name in the well, or its collapsed pill — SHALL raise a menu of the actions that act on the group as a whole: collapse/expand, rename, and delete. The repository tab's own context menu SHALL NOT carry those, keeping its actions scoped to one repository (its name, which group it belongs to, leaving that group, and closing it).

A collapsed group SHALL be right-clickable, since its members' tabs are folded away and it would otherwise have no menu at all.

#### Scenario: Group actions on the group, repository actions on the tab

- **WHEN** the user right-clicks a group
- **THEN** the menu offers collapse/expand, rename, and delete for that group, and none of the repository's own actions
- **AND** right-clicking one of its tabs offers the repository's actions — rename, group assignment, remove from group, close — and none of the group-wide ones

#### Scenario: A collapsed group still has a menu

- **GIVEN** a collapsed group with no tab drawn beside it
- **WHEN** the user right-clicks its pill
- **THEN** the group menu opens, offering "Expand group", "Rename group…", and "Delete group"

#### Scenario: Deleting a group leaves its repositories alone

- **WHEN** the user deletes a group from its menu
- **THEN** its member repositories become ungrouped, keeping their own custom names and their open tabs

### Requirement: A collapsed group never hides the active tab

A collapsed group holding the active repository's tab SHALL draw that tab beside its pill, folding away only its other tabs, so the strip always shows which repository is open. The pill and that tab SHALL sit together in the group's tinted well, so the tab still reads as a member of the group. The pill's count SHALL report every tab the group holds, including the one still drawn.

When the active tab moves out of a collapsed group — the user activates a repository elsewhere, or closes that tab — the group SHALL fold away completely without the user having to collapse it again.

#### Scenario: The active tab stays visible

- **GIVEN** a group holding `frontend`, `backend`, and `desktop`, with `desktop` active
- **WHEN** the user collapses the group
- **THEN** the group's pill is drawn with a count of 3, followed by the `desktop` tab, and `frontend` and `backend` are not drawn

#### Scenario: Activating elsewhere folds the group away

- **GIVEN** the state above
- **WHEN** the user activates an ungrouped tab
- **THEN** the group is drawn as its pill alone, with `desktop` no longer beside it, and the group remains collapsed

#### Scenario: Activating into a collapsed group

- **GIVEN** a collapsed group whose tabs are all folded away
- **WHEN** the user activates one of its repositories from the recent-repositories list
- **THEN** the group stays collapsed and that one tab is drawn beside its pill

### Requirement: Folded-away tabs are outside the drawn tab order

The tab order that the by-index shortcuts (⌘1…9), the step-to-neighbour shortcuts, and the tab a close lands on all follow SHALL be the order the strip actually draws — so a tab folded away inside a collapsed group is not a tab the user can step to or land on. A collapsed group's pill SHALL NOT itself be a position in that order.

#### Scenario: Stepping skips a collapsed group

- **GIVEN** tabs drawn as `[Acme collapsed: frontend backend] notes desktop`, with `notes` active
- **WHEN** the user presses the step-to-previous-tab shortcut
- **THEN** `desktop` is activated (wrapping past the collapsed group), not `backend`

#### Scenario: By-index skips a collapsed group

- **GIVEN** the state above
- **WHEN** the user presses ⌘1
- **THEN** `notes` is activated, because it is the first tab the strip draws

#### Scenario: Closing beside a collapsed group

- **GIVEN** the state above
- **WHEN** the user closes `notes`
- **THEN** `desktop` becomes active, not a tab folded away inside the collapsed group

### Requirement: Dragging a collapsed group

A collapsed group SHALL drag as one piece by its pill, moving all of its tabs — those drawn and those folded away — exactly as an expanded group does. A collapsed group SHALL NOT accept a tab dropped into it.

#### Scenario: Moving a collapsed group

- **GIVEN** a collapsed group and two ungrouped tabs
- **WHEN** the user drags the group's pill past both of them
- **THEN** the group is drawn after them, its membership is unchanged, and the new order is persisted

### Requirement: Recent worktree entries keep their repository identity across restarts

A recent entry for a linked worktree SHALL keep the repository it belongs to after a
restart. It keeps the repository's display name and group without waiting for a status
probe, and even when its path is currently missing.

#### Scenario: Restart with a worktree in recents
- **WHEN** the user opened a linked worktree of a named, grouped repository and restarts GitLane
- **THEN** the recents list shows that worktree with the repository's name and group dot straight away

#### Scenario: Worktree path is missing
- **WHEN** the worktree folder was removed before the restart
- **THEN** its recent row is still grouped under its repository, marked missing

### Requirement: A dragged tab or group follows the pointer

While a repository tab, a group, or a collapsed group's pill is being dragged, it SHALL be drawn under the pointer and move with it. It SHALL appear once on screen: the space it leaves in the strip SHALL stay empty. Starting a drag SHALL NOT select text or make the strip overflow when its tabs fit. This SHALL hold in the desktop app on every platform, under its own content security policy.

#### Scenario: Dragging a tab in the desktop app

- **GIVEN** the desktop app on macOS or Linux, with several open tabs
- **WHEN** the user presses a tab's drag handle and moves the pointer
- **THEN** the tab is drawn under the pointer and follows it
- **AND** no copy of it is drawn in the window's top-left corner or left behind in the strip

#### Scenario: Dragging a group

- **GIVEN** an expanded group of two tabs and two ungrouped tabs
- **WHEN** the user drags the group by its name
- **THEN** the whole tray is drawn under the pointer, its tabs travelling with it, and its original place in the strip is empty rather than showing a second copy

#### Scenario: No overflow while dragging

- **GIVEN** a tab strip whose tabs all fit without scrolling
- **WHEN** the user drags any tab or group across the strip
- **THEN** no horizontal scrollbar appears and the strip does not scroll

#### Scenario: No text selection during a drag

- **WHEN** the user drags a tab across other tabs' labels
- **THEN** no tab label becomes selected

### Requirement: Reordering settles while the pointer moves one way

While the user drags a tab or group steadily in one direction, each item it passes SHALL swap places with it once and SHALL NOT swap back unless the pointer reverses. This SHALL hold when the dragged item is narrower than the item it passes, including a whole group. Dropping SHALL persist the order shown at the moment of release.

#### Scenario: A tab passes a wider group

- **GIVEN** ungrouped tab `notes` drawn after an expanded group whose tray is much wider than `notes`
- **WHEN** the user drags `notes` steadily to the left, past the start of the group, and releases
- **THEN** the order changes once as `notes` passes the group, without flipping back and forth
- **AND** `notes` is drawn, and persisted, before the group

#### Scenario: A narrow tab passes a wide tab

- **GIVEN** two adjacent ungrouped tabs, the left one much wider than the right
- **WHEN** the user drags the narrow tab leftwards past the wide one
- **THEN** the two tabs swap once and stay swapped while the pointer keeps moving left

#### Scenario: Reversing direction

- **GIVEN** a drag that has just swapped a tab past its neighbour
- **WHEN** the user moves the pointer back the other way over that neighbour
- **THEN** the tab swaps back once

#### Scenario: Reordering inside a group

- **GIVEN** a group holding tabs of different widths
- **WHEN** the user drags its narrowest tab past its widest one within the group
- **THEN** the tabs swap once without flipping, and the tab stays inside its group

### Requirement: Opening a repository is acknowledged at once

When the user asks to open a repository that has a tab, by any route (tab click, tab shortcut, recents, session restore), that tab — or, for an in-place worktree switch, the tab being switched — SHALL be marked busy until the open ends, and SHALL show a busy indicator in place of its icon once the open has been pending for a brief delay (~200 ms). The repository already on screen SHALL stay on screen, uncleared, while the open is pending.

#### Scenario: Clicking a tab is acknowledged at once

- **WHEN** the user clicks an inactive repository tab
- **THEN** that tab shows a busy indicator within the brief delay, before the repository has opened
- **AND** the previously active repository stays on screen until the clicked one is shown

#### Scenario: A fast local switch does not blink the tab

- **GIVEN** a local repository that opens within the brief delay
- **WHEN** the user clicks its tab
- **THEN** the tab keeps its repository icon throughout and never shows the busy indicator

#### Scenario: An SSH tab names the connection phase

- **GIVEN** an SSH repository tab whose host connection is being re-established
- **WHEN** the user hovers the busy tab
- **THEN** its tooltip reads that it is connecting to that host, or that GitLane's agent is being installed with its progress

### Requirement: A slow open shows a workspace overlay

If an open is still pending after a short delay, the main workspace SHALL show a loading overlay naming the repository being opened; an open that finishes within the delay SHALL NOT show it. For a repository over SSH the overlay SHALL name the host, and the connection's phase (connecting, installing the agent) when one is known. The tab strip SHALL stay usable while the overlay is shown, and the overlay SHALL offer a Cancel that abandons the pending open.

#### Scenario: A fast local open does not flash the overlay

- **GIVEN** a local repository that opens in well under the overlay delay
- **WHEN** the user clicks its tab
- **THEN** the workspace switches to it without the loading overlay ever appearing

#### Scenario: A slow SSH open names what it is doing

- **GIVEN** an SSH repository tab whose host connection has to be re-established
- **WHEN** the user clicks the tab and the open takes longer than the overlay delay
- **THEN** the workspace shows a loading overlay naming that host — that it is connecting to it when the connection is known to be re-established, or that the repository is opening on it while an apparently live connection is still waiting
- **AND** if GitLane's agent has to be installed, the overlay shows the install stage and percent as it progresses

### Requirement: Launch restore shows the restored tab's open progress

When GitLane relaunches and reopens the last active repository, the screen SHALL say what it is waiting on once that open has started: the repository's name and, for a repository over SSH, the host and the connection's phase (connecting, installing the agent with its stage and percent) when one is known. It SHALL offer a Cancel that abandons that open. A generic restoring message SHALL be shown only before the open starts.

#### Scenario: A restored SSH tab names its host and phase

- **GIVEN** GitLane was quit with an SSH repository as the active tab
- **WHEN** GitLane relaunches and the host connection is being established
- **THEN** the screen names the repository and the host and says it is connecting to that host, instead of a generic restoring message
- **AND** if GitLane's agent has to be installed, the screen shows the install stage and percent as it progresses

#### Scenario: Cancelling a slow restore

- **GIVEN** GitLane is relaunching into an SSH repository whose host has not answered yet
- **WHEN** the user chooses Cancel on the restoring screen
- **THEN** the welcome screen is shown with the restored tabs still in the tab strip
- **AND** the open finishing or failing later changes nothing on screen

#### Scenario: A restore that fails still lands on the failure

- **GIVEN** GitLane is relaunching into an SSH repository whose host is unreachable
- **WHEN** the open fails
- **THEN** the disconnected state with Reconnect is shown, as for any failed SSH open

#### Scenario: A local restore is unchanged

- **GIVEN** GitLane was quit with a local repository as the active tab
- **WHEN** GitLane relaunches
- **THEN** the repository is shown without a Cancel ever appearing for an open that finishes quickly

### Requirement: Open progress ends with the open

The busy indicator and the overlay SHALL clear when the repository is shown, when the open fails, when a newer open supersedes it, when the user goes back to the repository on screen, or when the pending tab is closed. Only the latest open SHALL be shown as pending, and an earlier open finishing late SHALL NOT clear it.

#### Scenario: Cancelling from the overlay

- **GIVEN** a slow open is showing the overlay, with no tab to switch back to (for example from the welcome screen)
- **WHEN** the user chooses Cancel on the overlay
- **THEN** the overlay and any busy indicator disappear, the screen underneath stays as it was, and the open finishing or failing later changes nothing

#### Scenario: A failed open clears the progress

- **WHEN** a pending open fails
- **THEN** the busy indicator and the overlay disappear
- **AND** the failure is shown where it is shown today: the error bar, the missing-repository screen, or that screen's disconnected state with Reconnect for an unreachable SSH host

#### Scenario: A newer open supersedes a pending one

- **GIVEN** an open of tab A is still pending
- **WHEN** the user clicks tab B
- **THEN** only tab B shows the busy indicator, and the overlay (if shown) names B
- **AND** tab A's open finishing or failing later does not clear B's indicator or overlay

#### Scenario: Clicking the tab being switched

- **GIVEN** an in-place worktree switch of the tab on screen is pending
- **WHEN** the user clicks that same tab
- **THEN** the switch continues; only another tab or Cancel abandons it

#### Scenario: Going back to the repository on screen

- **GIVEN** an open of tab B is still pending while repository A is on screen
- **WHEN** the user clicks A's tab
- **THEN** the busy indicator and the overlay disappear, A stays on screen without reloading, and B's open finishing or failing later changes nothing

#### Scenario: Closing the pending tab

- **GIVEN** an open of a tab is still pending
- **WHEN** the user closes that tab
- **THEN** the busy indicator and the overlay disappear, and the open does not re-add the tab

### Requirement: The whole repository tab selects it

A single mouse click anywhere on a repository tab — its icon or drag grip, its label, or the padding and gaps between them — SHALL select that tab. The close button is the one exception: it SHALL close the tab and SHALL NOT also select it. Every part of the tab that selects it SHALL show the pointer cursor, so no part of the strip shows a hand over a spot that does nothing on click.

#### Scenario: Clicking the tab's padding selects it

- **GIVEN** two open repositories, `frontend` active and `backend` not
- **WHEN** the user clicks the `backend` tab in the gap between its icon and its name
- **THEN** `backend` becomes the active repository

#### Scenario: Closing does not select

- **GIVEN** two open repositories, `frontend` active and `backend` not
- **WHEN** the user clicks the close button on the `backend` tab
- **THEN** `backend` is closed and `frontend` stays active

#### Scenario: A drag does not select on release

- **GIVEN** two open repositories, `frontend` active and `backend` not
- **WHEN** the user drags `backend` by its grip to a new position and releases it
- **THEN** the tabs are reordered and `frontend` stays active
