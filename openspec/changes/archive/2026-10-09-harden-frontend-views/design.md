# Design

## Context

The evidence for each item is in `AUDIT.md`. Items owned here: 2, 11, 12, 13, 29–44, 46–53,
59, 60, 63, 66, 67, 79, 80, 81.

## Goals / Non-Goals

**Goals:** one route to the graph, one Escape owner stack, one source for forge
capabilities, and accent-aware colours, with each P0/P1 pinned by a test.

**Non-Goals:** visual redesign, new shortcuts, and store splits beyond item 37's move.

## Decisions

1. **Escape ownership (item 2).** Export `useEscapeOwner(onDismiss, active)` from
   `components/chrome/overlays/dialogs/frame.tsx`, which owns the `escapeOwners` stack, and use
   it in `ModalFrame` and `RepoOnboarding`. Features already import from `components/chrome`
   (e.g. `features/changes/WorkingInspector.tsx`). An `overlayOpen()` guard was rejected:
   `overlayOpen` includes `onboardingOpen`, so the overlay would never close.
2. **One route to the graph (items 13, 39).** Both call `useRepo.getState().returnToGraph()`.
   Search then keeps its open-only toggle.
3. **Center-view derivation (item 37).** `src/store/centerView.ts` holds `deriveCenterView`,
   `CenterViewInput` and `centerViewInputOf(repo, ui)`. It is not under `store/ui/`: it
   needs `ChangeSource` from `repoTypes`, and a `ui` slice importing a repo type breaks the
   store direction rule.
4. **Deferred refresh (item 30).** When `refreshIfCurrent`/`refresh()` returns `false`,
   `runMaybeConflict` and `runOperation` do not interpret `operation`. They await the
   flushed refresh through the existing deferral, then decide. `runOperation` stops setting
   `operation: null` before the refresh.
5. **Capabilities (item 31).** Gates read `forge?.capabilities` (`stacks === true`,
   `prCapabilities(forge) !== null`). `PR_FORGE_SPEC` stays for per-forge copy and links, with
   a generic fallback spec.
6. **Recents (item 11).** `persistRecents` writes `mainPath`. `readRecents` reads it when it
   is a string, else `null`, so old entries still load.

### Needs a decision (no task until decided)

- **Item 12, "theirs" colour.** One `--theirs` token that must contrast with every accent.
  For example orange for blue/indigo/cyan accents and blue otherwise, or a fixed non-accent
  hue.
- **Item 49, onboarding relative time.** Switching to `lib/relativeTime` changes copy
  ("yesterday" and "last week" become "1 day ago" and "7 days ago") unless lib gains those
  words.
- **Item 59, OAuth pass-throughs.** `oauthClientStatus`/`setOauthClientId` have no caller,
  even inside the OAuth dialog chain #448 kept. Delete them or wire them.

## Risks / Trade-offs

- [Item 29 turns silent failures into "unavailable" rows] → the section recovers on the
  next successful refresh, as it does on the refresh path.
- [Item 66 makes six TS booleans required] → test fixtures that omit them fail to
  typecheck. Fix the fixtures; no runtime change.
