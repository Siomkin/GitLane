# Proposal

## Why

The title-bar appearance button is a two-state flip (light ⇄ dark), so the third preference the store already supports — `system` (follow the OS) — can only be reached by opening Settings → General. Clicking the button while on `system` silently converts the preference to an explicit dark/light and the user loses OS-following without noticing. The reference design replaces the flip with a three-option picker (Auto / Light / Dark) opened from the same title-bar icon.

No Jira issue exists for this change.

## What Changes

- The title-bar theme button becomes a dropdown trigger: clicking it opens a small vertical menu with three options — **Auto** (system), **Light**, **Dark** — each an icon row; the current preference is highlighted.
- The trigger icon reflects the stored *preference*, not the resolved paint mode: an "auto" glyph for `system`, sun for `light`, moon for `dark`.
- Picking an option sets the preference and closes the menu. Outside click / Escape closes without changing anything.
- Settings → General's existing Appearance segmented control is unchanged and stays in sync (same store field).
- The store's `toggleTheme` action is removed — nothing else calls it once the title bar stops flipping.

## Capabilities

### New Capabilities
- `chrome/overlays`: window-chrome overlays — this delta covers the title-bar appearance menu (three-way theme preference picker). Later chrome menus/dialogs extend the same capability.

### Modified Capabilities
- none

## Impact

- Process: **frontend only**. No Rust, no IPC, no new dependency, no secrets/auth surface.
- Code: `src/components/chrome/TitleBar.tsx` (trigger swap), a new `src/components/chrome/AppearanceMenu.tsx` copying the `IdentityChip` popover pattern (`useState` + `useDismiss`), `src/store/ui/appearance.ts` (drop `toggleTheme`), one new icon in `src/components/ui/icons.tsx`, a new `AppearanceMenu.test.tsx`.
- Persistence: the `theme` field and its persisted values (`dark` / `light` / `system`) are unchanged — no migration.

## Non-goals

- No change to the Settings → General Appearance control or to how the theme resolves/paints (`resolveTheme`, `useResolvedTheme`).
- No keyboard chord for cycling themes.
- No language/locale switcher (the "EN" button in the reference is not part of this change).
- No new entry in the ui store's single `menu` slot — this popover is local component state like `IdentityChip`.
