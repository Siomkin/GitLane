# Proposal

## Why

Dragging repository tabs in the title-bar strip is broken in the desktop app on macOS
and Ubuntu, and unreliable everywhere:

- **In the app only:** when a drag starts, a copy of the dragged tab appears pinned in the
  window's top-left corner and doesn't follow the pointer. The tab's placeholder also stays
  visible in the strip, so the tab appears twice, and a horizontal scrollbar sometimes appears
  in a strip that has room.
- **Everywhere:** when a narrower item passes a wider one, the order flips back and forth every
  few pixels. Across a group tray it is at its worst. In a scripted drag in the browser pane,
  a 116px tab dragged across a 344px group flipped 49 times and never got past it. Across a
  183px tab it flipped 23 times.

Jira: none.

## What Changes

- **Drag styling works under the app's CSP.** dnd-kit (`@dnd-kit/dom` 0.5.1) styles a drag
  through a `<style>` element it adds at runtime. The app's CSP (`style-src 'self'`) blocks
  that element, by a decision recorded in `docs/tauri-plugin-decisions.md`. The Vite dev
  server sends no CSP, which is why the browser works. The rules that place the dragged item
  under the pointer, hide its placeholder, make it ignore the pointer, and stop text selection
  during a drag will ship in a bundled stylesheet instead. The CSP stays as it is.
  Precedent: xterm.js hit the same block and got `src/features/terminal/xtermAnsi.css`.
- **Reordering stays put once it has swapped.** The tab-strip sortables get a collision rule
  that doesn't swap an item straight back while the pointer keeps moving the same way, in
  place of dnd-kit's default "which item is the pointer inside" rule.
- **The CSP decision record** gains an entry for the dnd-kit stylesheet, alongside xterm's.
- No change to what can be dragged where (whole groups, tabs only within their own group,
  collapsed pills). That stays as `chrome/repo-tabs` specifies.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chrome/repo-tabs`: adds a requirement for how a tab or group behaves while it is being
  dragged: it follows the pointer, the strip doesn't show it twice or overflow, and the order
  settles instead of flipping when items differ in width.

## Non-goals

- Reopening `style-src` (`'unsafe-inline'` or a runtime nonce). The decision record rejects it.
- Replacing dnd-kit, upgrading it (0.5.2 is still beta), or rewriting the tab strip.
- New drag behaviors: dragging tabs between groups, drag-to-group, a custom drag preview, or
  drag animations.
- Other drag surfaces (branch drag-and-drop in the history graph and the branch navigator),
  which don't use dnd-kit.

## Impact

- **Process:** frontend only. No Rust, no IPC, no `tauri.conf.json` change.
- **Code:** `src/components/chrome/repo-tabs/` (`RepoTabRun.tsx` and a new bundled stylesheet
  imported by the strip), plus tests next to them.
- **Docs:** `docs/tauri-plugin-decisions.md`, Content Security Policy section.
- **Dependencies:** none new. `@dnd-kit/collision` is already installed as a dependency of
  `@dnd-kit/dom`. Whether to declare it directly is a design decision.
- **Security:** none. The CSP is unchanged and stays closed to injected `<style>`. No secrets,
  auth, or IPC involved.
- **Upgrade risk:** the bundled rules copy dnd-kit's internal attribute names
  (`data-dnd-dragging`, `data-dnd-placeholder`) and CSS variables (`--dnd-*`). A dnd-kit
  upgrade can rename them, so a test guards the copy.
