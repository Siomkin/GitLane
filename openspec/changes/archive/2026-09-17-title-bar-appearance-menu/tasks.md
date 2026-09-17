# Tasks

## 1. UI

- [x] 1.1 Add `AutoThemeIcon` to `src/components/ui/icons.tsx` in the existing stroke style; verify it renders at `h-4 w-4` next to `SunIcon`/`MoonIcon` in `bun run tauri dev`.
- [x] 1.2 Create `src/components/chrome/AppearanceMenu.tsx` copying the `IdentityChip` popover pattern (`useState` + `useDismiss`): trigger button whose icon/tooltip follows `useUi((s) => s.theme)`, and a `role="menu"` panel with three `role="menuitemradio"` rows (Auto/system, Light, Dark) calling `setTheme` then closing; selected row `aria-checked` + highlighted. Verify manually: all three selectable, outside click and Escape close without change.
- [x] 1.3 In `src/components/chrome/TitleBar.tsx` replace the toggle button with `<AppearanceMenu />` and drop the now-unused `useResolvedTheme`, `SunIcon`, `MoonIcon`, `toggleTheme` imports; verify `bunx tsc --noEmit` passes.

## 2. Store

- [x] 2.1 Remove `toggleTheme` from `src/store/ui/appearance.ts` (interface + impl + comment); verify `bunx tsc --noEmit` reports no remaining callers.

## 3. Tests

- [x] 3.1 Add `src/components/chrome/AppearanceMenu.test.tsx` (dom project): opening lists Auto/Light/Dark; choosing Auto sets `useUi.getState().theme === "system"` and closes; the selected row has `aria-checked="true"`; Escape closes without changing `theme`; trigger label reads "Auto" when theme is `system` even with a dark `matchMedia` mock. Verify `bun run test -- AppearanceMenu` passes.
- [x] 3.2 Confirm `src/components/chrome/settings/GeneralPanel.test.tsx` still passes (shared `theme` field, no behaviour change) via `bun run test`.

## 4. Definition of done

- [x] 4.1 `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes` all pass (use the project `verify` agent).
- [x] 4.2 Manual check in `bun run tauri dev`: set Auto in the title bar, flip the OS appearance, app follows; set Light in Settings → General, title-bar trigger shows the sun.
