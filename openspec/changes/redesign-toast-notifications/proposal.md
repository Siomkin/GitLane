# Proposal

## Why

Toast notifications look heavy and close badly. A coloured strip runs down the left edge, a countdown bar runs along the bottom, and a closing card vanishes in one frame so the stack jumps. Errors and most toasts with an action never close on their own. A separate bug freezes every later toast: closing the last card while the pointer is over it leaves the hover pause on, so the next toast stays until it is hovered or clicked.

There is no Jira issue for this change.

## What Changes

- Remove the left accent strip and the bottom countdown bar from every toast.
- Give each card a soft glow in its status colour, starting at the top-left corner and fading into the normal card surface.
- Animate closing: the card fades out to the left, then the stack closes the gap smoothly. Reduced-motion users get no animation.
- Set auto-close windows by default: 5 s for info, success and neutral, 8 s for warning, 10 s for a toast with an action, 12 s for an error. In-flight progress still waits for its result. A window a caller sets explicitly still wins.
- **BREAKING (behaviour):** error toasts and toasts with an action no longer wait for the user by default. Hovering the stack still holds them open.
- Combine the status icon and close button at the card's right edge: the icon shows × when the card is hovered or the button has keyboard focus, giving the text the card's full remaining width.
- Fix the stuck hover pause, so closing the last toast never freezes later ones.

## Non-goals

- A notification history or log of past toasts.
- Moving the stack, changing its size limit of four, or changing its status glyphs, copy or action buttons.
- Changing which events raise a toast.
- A user setting for toast durations.
- Animating a card that is dropped because the stack is over its limit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chrome/overlays`: adds requirements for toast appearance, auto-close windows, hover hold and closing motion. The capability has no toast requirements today, so nothing existing is replaced.

## Impact

- **Process:** frontend only. No Rust, IPC command, dependency, Tauri plugin or CSP change.
- **Secrets and auth:** no change. Toast content and its existing redaction are untouched, and no credential enters the store.
- **Code:** `src/store/notifications.ts` (windows, closing state, pause fix), `src/components/chrome/overlays/notifications/` (`ToastCard`, `ToastStack`, `model.ts`, `index.ts`), the toast section of `src/App.css`, and one comment in `src/store/ui/toasts.ts`.
- **Tests:** `src/store/notifications.test.ts` and `ToastStack.test.tsx` assert the old persistence and need updating.
- **Pattern to copy:** the store's existing timer handling and the `nf-*` CSS keyframe section in `App.css`.
