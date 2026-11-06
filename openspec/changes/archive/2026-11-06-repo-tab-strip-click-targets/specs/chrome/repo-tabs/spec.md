# Spec Delta

## ADDED Requirements

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

## MODIFIED Requirements

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
