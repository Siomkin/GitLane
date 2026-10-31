# Spec Delta

## ADDED Requirements

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
