## ADDED Requirements

### Requirement: Collapsing a group

A repository group SHALL be collapsible. A collapsed group SHALL be drawn as a single pill carrying a chevron, the group's name, and the number of tabs it holds, in place of its well and its tabs. An expanded group SHALL be drawn as its well, as specified by "Grouped tab strip".

Collapsing SHALL be a double-click of the group's name and expanding a double-click of the collapsed pill — one gesture in both directions. The pill is one control end to end; nothing inside it is separately clickable. A single mouse click SHALL NOT toggle a group, so the press that drags it cannot toggle it on release; keyboard activation of the pill SHALL still toggle. The expanded well SHALL carry no other collapse control, so it stays exactly as "Grouped tab strip" specifies.

A group's collapsed state SHALL persist with the user's other view preferences, so a collapsed workspace survives quitting and reopening the app. Collapsing SHALL NOT change any tab's group membership, the stored tab order, or which repository is active.

#### Scenario: Collapsing a group

- **GIVEN** an expanded group "Acme" holding three tabs, none of them active
- **WHEN** the user double-clicks the group's name (or picks "Collapse group" from the group's context menu)
- **THEN** the group's well and its three tabs are replaced by one pill reading "Acme" with a count of 3, behind a chevron

#### Scenario: Expanding a group

- **GIVEN** a collapsed group
- **WHEN** the user double-clicks its pill (or picks "Expand group" from the group's context menu)
- **THEN** its well is drawn again with all of its tabs, in the order they had before it was collapsed

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

A collapsed group holding the active repository's tab SHALL draw that tab beside its pill, folding away only its other tabs, so the strip always shows which repository is open. The pill's count SHALL report every tab the group holds, including the one still drawn.

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
