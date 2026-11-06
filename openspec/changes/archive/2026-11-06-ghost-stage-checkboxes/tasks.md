# Tasks

## 1. Shared checkbox look (`src/components/ui/TriStateCheckbox.tsx`)

- [x] 1.1 Change the unchecked state to a transparent border and background, revealed by `group-hover:`, its own `hover:` (faint accent tint), and `focus-visible:` (light and dark border colours); make checked/mixed a faint translucent accent tint (~10% background, ~40% border, full-accent icon) instead of a solid fill, `rounded-[5px]`, and `opacity-45` for disabled. Verify `bun check` passes.
- [x] 1.2 Add `src/components/ui/TriStateCheckbox.test.tsx` asserting: unchecked carries the transparent-border and `group-hover:` reveal classes; checked renders the check icon with the tinted (not solid) accent classes; mixed renders the dash; a disabled box ignores clicks and uses the reason as its title. Verify `bun run test src/components/ui/TriStateCheckbox` passes.

## 2. Hover groups on hosting rows

- [x] 2.1 Add `group` to the "Changes (N)" header row in `src/features/changes/IncludeFileSection.tsx`, and confirm `FileRow.tsx` and both `ChangedFileList.tsx` rows already reveal their box on hover (no change expected). Verify `bun run test src/features/changes/IncludeFileSection` passes.
- [x] 2.2 Leave the Include diff gutter in `src/features/review/include-diff/IncludeReview.tsx` relying on the box's own hover (D2); verify `bun run test src/features/review/include-diff` still passes.

## 3. Review-all rows adopt the shared checkbox (`src/features/changes/changes-workspace/ReviewFileSection.tsx`)

- [x] 3.1 Replace the hand-rolled button with `TriStateCheckbox` (`checked={staged}`, same labels and `disabledReason`, click/keydown still don't toggle expansion), add `group` to the header row, and drop the `DIFF_ADD` import if it's unused. Verify `bun check` passes.
- [x] 3.2 Update `ReviewFileSection.test.tsx` / `ChangesWorkspace.test.tsx` for the new markup (query by role `checkbox` and `aria-checked`, not the "✓" text); verify `bun run test src/features/changes` passes.

## 4. Integration checks

- [x] 4.1 Run the `verify` agent (`bun check`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`) and confirm every check exits 0.
- [x] 4.2 In `bun run tauri dev`, in light and dark themes with a non-default accent: idle lists show no empty boxes; hovering or tabbing reveals them; checked and mixed boxes match between review-all and Include; the Staging area is unchanged.
