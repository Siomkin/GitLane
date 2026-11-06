# Design

## Context

`TriStateCheckbox` (`src/components/ui/TriStateCheckbox.tsx`) is the one shared stage/include
checkbox: a `<button role="checkbox">`, 16px, accent-filled when on, `CheckIcon` or a dash
inside, and `focusRing`. Its only callers are the Include view (`FileRow`, `ChangedFileList`,
`IncludeFileSection`) and the Include diff gutter (`IncludeReview`). The review-all row
(`ReviewFileSection`) draws its own button with a "✓" glyph on `DIFF_ADD` green. No store is
involved. No file is near the size ceiling: the largest touched file is `ChangedFileList.tsx`
at 338 lines, and the change adds only class names there.

## Goals / Non-Goals

**Goals:** one look for every stage/include checkbox; unchecked boxes hidden until row hover or
focus; no layout shift.

**Non-Goals:** a new prop matrix or variants; touching native form checkboxes.

## Decisions

### D1. Make ghost-until-hover the default look of `TriStateCheckbox`

Every current caller is a staging list, so the shared component's unchecked state becomes:
`border-transparent bg-transparent`, revealed by `group-hover:border-black/25` (white in dark
mode), its own `hover:`, and `focus-visible:`. Checked and mixed states switch from a solid fill to a tint: the background is the accent at
about 10% (`color-mix(in srgb, var(--accent) 10%, transparent)`), the border is the accent at
about 40%, and only the check/dash uses the full `var(--accent)`. The user asked for this softer
setting after seeing 18%. The tint mixes over whatever surface sits behind it, so it holds up in dark
mode and on a selected row.
Use `rounded-[5px]` and a slightly thinner check icon to match the mockup. Hovering an unchecked
box tints it with the accent at low opacity.

*Alternative:* a `reveal="hover"` prop. Rejected for now: there is no caller that wants the
always-visible look, and adding a knob nobody uses goes against the restraint rule. If a
non-staging caller appears later, it can add the prop then.

### D2. The reveal is driven by the row's `group`, plus the box's own hover

`FileRow` and both rows in `ChangedFileList` already carry `group` (they use it to reveal row
actions). Add `group` to the `IncludeFileSection` header row and the `ReviewFileSection` header.
In the Include diff gutter the line row is owned by the shared diff body, so don't thread a group
through it. The box's own `hover:` reveals it there, and an excluded difference stays easy to
spot because of its visible revert ("»") control.

### D3. The review-all row adopts `TriStateCheckbox`

Replace the hand-rolled button with `TriStateCheckbox checked={staged}`. Keep the existing
labels ("Stage <path>" / "Unstage <path>"), `disabledReason`, and the `stopPropagation` on
click/keydown, so ticking still doesn't toggle the row's expansion. This removes the
`DIFF_ADD` import if nothing else in the file uses it.

### D4. Disabled stays `opacity-45` once revealed

A disabled unchecked box stays invisible when idle, like any other unchecked box. On row hover
it shows dimmed, and its `title` carries `disabledReason`, as today.

## Risks / Trade-offs

- [Unchecked state is less discoverable] → this is the chosen trade-off. The review-all toolbar
  already says "Tick a file to stage it", and keyboard focus still reveals the box.
- [Tests that query checkboxes by role] → they keep working: the element and `aria-checked`
  don't change. Only tests asserting the "✓" text or inline green styles in `ReviewFileSection`
  need updating.
- [happy-dom can't evaluate hover CSS] → test the class contract (unchecked carries the
  transparent border plus the `group-hover:` class), and check the real hover by eye in the app.
