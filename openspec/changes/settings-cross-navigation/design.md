# Design: settings-cross-navigation

## Context

See proposal.md, "Why", for the problems. The requirements are in
`specs/chrome/settings-navigation/spec.md`.

This change is frontend only. There is no git engine, IPC, or Rust work: every
action reuses existing store actions.

- The two windows are independent modals. Each has its own `ui` slice:
  `settings.ts` holds `settingsOpen`, `settingsTab`, and the one-shot intents;
  `windows.ts` holds `repoSettingsOpen` and `repoSettingsSection`.
  `resetRepoScopedWindows` closes Repository settings when the repository
  changes, while App settings survives.
- Hand-offs already exist in one direction. `RepoSettingsModal.goGlobal` closes
  Repository settings and then opens App settings. `CommitAsZone` does the same
  with `openIdentitiesSettings`. `openAccountsSettings(intent)` lands Accounts on
  a provider's connect view, and auth-failure toasts already use it.
- `features/onboarding/authRecovery.ts:45` already maps a remote's provider to a
  connect intent: `"github"`, or else `forgeAuthProviderFor(provider)`.
- Escape is a stack: `useEscapeOwner(onDismiss, active)` in
  `overlays/dialogs/frame.tsx`. The most recently registered owner answers.

## Goals / Non-Goals

**Goals:** add the three missing paths between the windows, and make the identity
picker dismissible. Both should reuse the existing hand-off actions.

**Non-Goals:** no new store, no change to transport-auth resolution, and no
inline connect UI. The full list is in the proposal's "Non-goals".

## Decisions

### D1. The return target is a transient field in the `settings` slice

Add `settingsReturn: { repoPath: string; repoName: string; remote: string; accountIdsBefore: string[] } | null` to
`SettingsSlice`, and let `openAccountsSettings` take it as an optional third
argument. `closeSettings` clears it, as it already clears the intents. It is not
persisted. Add a `returnToRepoSettings()` action that reads the record, closes
App settings, and calls `openRepoSettings("remotes")`. Both slices live in the
same `ui` store, so no store-to-store link is needed.

*Alternative considered:* keeping the return state in component state inside
`SettingsModal`. That fails because the opener lives in the other modal's
subtree.

### D2. The new account is bound in `RepoSettingsModal`, not in the store

The `ui` store sits below `accounts` in the import order, so `ui` cannot read
accounts. `returnToRepoSettings` therefore leaves a one-shot
`repoSettingsBindHint` (the same record) for `RepoSettingsModal` to consume on
open. That component already reads both stores. It computes
`accounts.filter(matchesRemoteHost && !accountIdsBefore.includes(id))`. When
exactly one account remains and the remote has no binding
(`repoRemoteAccountIds[remote]` is unset), it calls the existing
`setRemoteAccount`. Then it clears the hint.

The `matching` list from `remoteAccountPickerModel` provides the host match, so
there is no new matching rule.

*Alternative considered:* auto-binding the moment a connect succeeds inside
Accounts. That would bind a remote the user may never return to, and it would
couple the Accounts panel to repo state.

### D3. The connect action lives in `RemoteAccountPicker`

The picker gets a `connectIntent: AccountsConnectIntent | null` prop and an
`onConnect` callback.

- The intent is computed by the helper that `authRecovery.ts` uses. Move it to
  `lib/remotes.ts` as `connectIntentFor(provider)` and have both callers use it.
- SSH remotes and remotes with no intent get `null`, so no action is shown.
- `RemotesPanel` wires `onConnect`: it snapshots `accounts.map(a => a.id)`, calls
  `closeRepoSettings()`, then calls `openAccountsSettings(intent, undefined,
  { remote, accountIdsBefore })`.
- Button text: "Connect <providerLabel> account…" when `matching` is empty;
  otherwise a quiet "Connect another…" link beside the select.
- A `<select>` option was rejected: an option that navigates away is surprising
  and is harder to reach with the keyboard.

### D4. Back link and repository entry live in `SettingsModal`

- When `settingsReturn` is set, a "← Back to <repo>" link renders above the
  panel content.
- When `useRepo(s => s.summary)` is non-null, the sidebar gets a
  "THIS REPOSITORY" group with one entry, named with the same `repoSlug` that
  `RepoSettingsModal` uses. Export `repoSlug` from there, or move it to
  `lib/paths`.
- The entry calls `closeSettings(); openRepoSettings();`. This mirrors
  `goGlobal`.
- `SettingsModal.tsx` is 164 lines today, and roughly 30 lines are added.
  `bun run sizes` must stay green. If it fails, move the sidebar `<nav>` into a
  `SettingsSidebar.tsx`, mirroring `RepoSettingsSidebar`.

### D5. Picker cancel uses the Escape owner stack

In `CommitAsZone`, call `useEscapeOwner(() => setPicking(false), picking)`.
While the picker is expanded, this registers above `RepoSettingsModal`'s frame
owner, so one Escape collapses only the list. Inside the list group, add a
footer row with "+ New identity…" on the left and "Cancel" on the right. The new
identity action reuses `openIdentitiesSettings({ kind: "new" })`, after
`closeRepoSettings()`. No new state is needed.

## Risks / Trade-offs

- [Risk] The repository switches while App settings is open with a return target,
  and Back reopens settings for the new repository. → Store the repository path in
  `settingsReturn`. Back only reopens settings, and only binds an account, when it
  still matches the open repository's path. Otherwise the link is hidden.
- [Risk] Hard-binding a remote writes a `git remote set-url` username, which is a
  side effect the user didn't explicitly choose. → Bind only when the remote was
  unbound and exactly one new matching account exists. In that case the user's
  intent is unambiguous. Every other case leaves the dropdown for the user to
  pick.
- [Trade-off] Keychain-token providers such as Bitbucket don't show up as picker
  accounts, so nothing is auto-bound for them. Their Account note already
  updates on its own when a token appears, which is enough.

## Migration Plan

None. The change is UI only, with no persisted state.
