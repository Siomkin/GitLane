# Tasks

## 1. Identity picker cancel

- [x] 1.1 In `CommitAsZone.tsx`, call `useEscapeOwner(() => setPicking(false), picking)`, and add a footer to the expanded list with "+ New identity…" (calls `closeRepoSettings()` then `openIdentitiesSettings({ kind: "new" })`) and "Cancel" (calls `setPicking(false)`). Verify with new cases in `IdentityPanel.test.tsx`: Cancel collapses the list and calls no `applyCommitSource`; Escape collapses the list while `closeRepoSettings` is not called; New identity opens Identities with a `new` intent.

## 2. App settings → Repository settings link

- [x] 2.1 Export `repoSlug` from `RepoSettingsModal.tsx`, or move it to `lib/paths.ts`, and import it in both modals. Verify with `bun check`.
- [x] 2.2 In `SettingsModal.tsx`, render a "THIS REPOSITORY" sidebar group with the repo name and an ↗ icon when `useRepo(s => s.summary)` is set. Clicking it calls `closeSettings()` then `openRepoSettings()`. Verify with a `SettingsModal` test: the entry is present with a repo open, absent with none, and the click swaps the windows.

## 3. Connect account from a remote, with return

- [x] 3.1 Move the provider→connect-intent mapping from `features/onboarding/authRecovery.ts:45` into `lib/remotes.ts` as `connectIntentFor(provider)`, and switch `authRecovery.ts` to it. Verify that the existing authRecovery tests pass.
- [x] 3.2 In `store/ui/settings.ts`, add `settingsReturn` (`{ repoPath, repoName, remote, accountIdsBefore }`), an optional third arg on `openAccountsSettings`, clearing in `closeSettings`, and `returnToRepoSettings()`. That action closes App settings, sets a one-shot `repoSettingsBindHint`, and calls `openRepoSettings("remotes")`. Verify with slice unit tests: set, clear on close, and return opens the remotes section.
- [x] 3.3 In `RemoteAccountPicker.tsx`, add `connectIntent` and `onConnect` props. Render "Connect <Provider> account…" when there are no matching accounts and the intent is non-null, and "Connect another…" next to the select. Render nothing for SSH remotes or a null intent. Wire it through `RemoteRow` and `RemotesPanel`: snapshot account ids, `closeRepoSettings()`, then `openAccountsSettings(intent, undefined, { … })`. Verify with `RemoteAccountPicker.test.tsx` cases for the GitHub no-match, dropdown, SSH, and other-forge cases.
- [x] 3.4 In `SettingsModal.tsx`, render "← Back to <repoName>" when `settingsReturn.repoPath` equals the open repo's path, wired to `returnToRepoSettings()`. Verify with a test: the link shows only for a matching repo, and clicking it swaps the windows onto Remotes.
- [x] 3.5 In `RepoSettingsModal.tsx`, consume `repoSettingsBindHint` on open. If the remote is unbound and exactly one new account matches its host (via `remoteAccountPickerModel(...).matching`), call `setRemoteAccount`. Clear the hint either way. Verify with `RepoSettingsModal.test.tsx` cases for one new account (bound), an already-bound remote (unchanged), and no new account (unchanged).

## 4. Integration checks

- [x] 4.1 Run `bun check`, `bun run test`, `bun run build`, `bun run sizes`, and `bun run cycles`, all green. If `SettingsModal.tsx` breaks the size ceiling, split its sidebar `<nav>` into `SettingsSidebar.tsx`.
- [ ] 4.2 In `bun run tauri dev`, walk through: Change → Escape keeps the window open; Repository settings → Connect GitHub account → Back lands on Remotes; App settings sidebar → repository entry opens Repository settings.
