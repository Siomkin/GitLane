# Design

## Context

`src/store/ui/appearance.ts` already stores `theme: "dark" | "light" | "system"` (persisted) with `setTheme`; `src/lib/theme.ts` + `src/hooks/useResolvedTheme.ts` resolve it to the paint mode. The only gap is the title-bar UI: `TitleBar.tsx` renders one button wired to `toggleTheme`, which resolves `system` first and then flips, so Auto is unreachable and is silently lost on click. Settings → General already renders a three-way `Segmented` over the same field.

## Goals / Non-Goals

**Goals:**
- Three-way picker in the title bar, matching the reference (vertical icon list: auto / sun / moon, selected item highlighted).
- Zero store or persistence changes beyond deleting dead code.

**Non-Goals:**
- Reworking how theme resolves or paints.
- Generalising a "chrome dropdown" primitive; two call sites (IdentityChip, this) is not enough to justify one.

## Decisions

- **Engine**: none — pure frontend, no IPC, no Rust.
- **Store**: `ui` (appearance slice). Use the existing `setTheme`. Delete `toggleTheme` (its only caller was TitleBar; grep confirms no shortcut or test uses it). Trigger icon keys off the raw `theme` preference via `useUi((s) => s.theme)`, not `useResolvedTheme`, so Auto shows its own glyph.
- **Popover pattern**: copy `IdentityChip.tsx` — a `relative` wrapper, local `useState(open)`, `useDismiss(open, close, ref)` for outside-click/Escape, absolutely-positioned panel under the trigger. Do **not** add a `MenuKind` to the ui store's single `menu` slot; that slot is for coordinate-anchored context/action menus, and this popover has no payload.
- **Component placement**: new `src/components/chrome/AppearanceMenu.tsx` (trigger + panel, ~60 lines) so `TitleBar.tsx` only swaps one button for `<AppearanceMenu />` and stays small. Options are a const array `[{ value: "system", label: "Auto", Icon }, …]` rendered as `role="menuitemradio"` buttons with `aria-checked`, `title`/`aria-label` = label; selected row gets the accent-tinted background used elsewhere for active segmented items. Panel container gets `role="menu"` and `aria-label="Appearance"`.
- **Icon**: add one `AutoThemeIcon` to `src/components/ui/icons.tsx` in the same 24-viewBox stroke style (a sun-ish badge with an "A", per the reference; a half-filled circle is the fallback if the letter reads poorly at 16px). Reuse `SunIcon` / `MoonIcon`.
- **No new dependency** — checked against `docs/tauri-plugin-decisions.md`; nothing native or JS is added.
- **Size ceiling**: `TitleBar.tsx` shrinks; `AppearanceMenu.tsx` is far below the 200-line look band; `icons.tsx` grows by one ~8-line function (check `bun run sizes` still passes since that file is shared).

## Risks / Trade-offs

- [Trigger now reflects preference, not paint mode — a user on Auto/dark sees the auto glyph, not a sun] → intended per the reference; tooltip reads "Appearance: Auto".
- [Removing `toggleTheme` breaks any external caller] → grep shows only TitleBar; tsc catches anything missed.
- [Popover clipped by the `overflow-x-auto` tab strip container] → the trigger sits in the right-hand `ml-auto` group, outside that container, same as IdentityChip's popover which already works there.

## Migration Plan

None. Persisted `theme` values are unchanged; a user previously on `system` who lost it via the flip simply regains the option.
