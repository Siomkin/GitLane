# changes/stage-controls Specification

## Purpose

Covers how the Changes tab's stage and include checkboxes look and appear, in the multi-file
review and in the Include view, so the lists stay quiet while each control stays easy to find.

## Requirements

### Requirement: Unchecked boxes appear only on hover or focus

An unchecked stage or include checkbox SHALL show no visible outline while neither the pointer
nor keyboard focus is on its row. It SHALL appear when the pointer is over its row or the box
itself, or when the box has keyboard focus. Its space in the row SHALL stay reserved, so rows
do not shift when it appears.

#### Scenario: Idle list shows no empty boxes

- **GIVEN** the Include view lists files that are not included
- **WHEN** the pointer is elsewhere and no box has focus
- **THEN** those files' rows show no checkbox outline
- **AND** the file names stay aligned with rows that show a checked box

#### Scenario: Hovering a row reveals its box

- **WHEN** the pointer moves over an unchecked file row
- **THEN** that row's checkbox outline appears, and clicking it checks the box

#### Scenario: Keyboard focus reveals the box

- **WHEN** the user tabs onto an unchecked checkbox
- **THEN** the box is visible with a focus ring

### Requirement: Checked and mixed boxes are always visible in a soft accent tint

A checked box SHALL always be visible as a square with a translucent tint of the app accent,
with a light accent outline and a check mark in the full accent colour. It MUST NOT be a solid accent fill.
A partly checked box SHALL use the same tinted square with a dash. The same look SHALL be
used in the multi-file review and in the Include view.

#### Scenario: Staged file in review-all

- **WHEN** a file in the multi-file review is staged
- **THEN** its checkbox shows the tinted accent square with an accent check, the same as a checked file in the Include view

#### Scenario: Partly included folder

- **WHEN** some but not all files under a folder in the Include view are included
- **THEN** the folder's checkbox shows the tinted accent square with an accent dash, whether or not the row is hovered

#### Scenario: Accent colour follows settings

- **WHEN** the user changes the app accent colour
- **THEN** checked and mixed boxes use the new accent colour

### Requirement: A disabled box explains itself when revealed

When a checkbox cannot be toggled, hovering its row SHALL reveal it in a dimmed state, and its
tooltip SHALL give the reason. Clicking it SHALL do nothing.

#### Scenario: Guarded file

- **GIVEN** a file whose staging is blocked during an in-progress operation
- **WHEN** the user hovers its row
- **THEN** the dimmed box appears with the blocking reason as its tooltip, and clicking it does not stage the file
