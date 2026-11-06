# Proposal

## Why

The stage/include checkboxes in the Changes tab look dated and busy. A long list shows a column
of empty outlined boxes, and the review-all rows draw their own box with a heavy bold "✓" text
character on a hard-coded green that matches nothing else. The user picked a quieter style from
mockups ("ghost until hover"): an unchecked box is invisible until you hover its row, and a
checked or partly checked box is a soft, translucent accent square with a thin accent-coloured
check or dash.

There is no Jira issue for this.

## What Changes

- An **unchecked** stage/include checkbox has no visible outline until the pointer is over its
  row or the box has keyboard focus. Its space in the layout stays reserved, so rows don't shift.
- A **checked** box is always visible: a faint translucent accent tint (about 10% of the app accent)
  with a light accent outline (about 40%) and a check mark in the full accent colour. It is not a solid accent fill.
  A **partly checked** (mixed) box is the same square with a dash.
- Hover over a box gives it a faint accent tint. A disabled box still shows its reason as the
  tooltip when hovered.
- The review-all rows (Changes tab → "Reviewing N changed files") stop drawing their own box and
  use the same shared checkbox, so the diff-green fill and the "✓" glyph go away.
- Applies everywhere the shared checkbox is used today: review-all file rows, the Include view's
  section header ("Changes (N)"), folder and file rows, and the per-difference boxes in the
  Include diff.

## Capabilities

### New Capabilities

- `changes/stage-controls`: how the Changes tab's stage/include checkboxes look and reveal
  themselves across the review-all list and the Include view.

### Modified Capabilities

None.

## Impact

- Frontend only (React/Tailwind). No Rust, IPC, store, or secret/auth surface.
- `src/components/ui/TriStateCheckbox.tsx`: the visual states change; the API stays the same.
- `src/features/changes/changes-workspace/ReviewFileSection.tsx`: the custom button is replaced
  by `TriStateCheckbox`.
- Rows that host the checkbox need a hover group: `FileRow.tsx` and `file-list/ChangedFileList.tsx`
  already have one; `IncludeFileSection.tsx`, the `ReviewFileSection` header, and the Include
  diff gutter (`include-diff/IncludeReview.tsx`) get one, or rely on the box's own hover.
- Pattern to copy: the existing hover-reveal of row actions in `FileRow.tsx`
  (`group` + `group-hover:` + `focus-visible:`).

## Non-goals

- The Staging area view, with its Stage/Unstage buttons and U/A badges, stays as it is.
- Plain form checkboxes (commit amend, PR dialogs, settings) are not touched.
- No new colour tokens and no change to the accent picker.
- No change to what checking a box does (stage, unstage, include, exclude).
