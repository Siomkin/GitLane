# Proposal: settings-cross-navigation

Jira: no issue yet.
Process: frontend only. There are no Rust, IPC, or command changes.

## Why

The two settings windows are hard to move between, and one picker traps you:

1. **You can't add an account from Repository settings.** A remote with no matching account shows only a note, such as "Use a connected GitHub account…". A remote that has a dropdown offers no way to add another account. To add one, you have to close the window, find App settings → Accounts, connect there, and then reopen Repository settings yourself.
2. **The identity picker can't be cancelled.** After you click **Change**, the radio list stays open until you pick a row. There is no Cancel button, and Escape closes the whole window.
3. **App settings doesn't link back to Repository settings.** The Accounts page says accounts are "picked per remote in Repository settings → Remotes", but it gives no way to get there. Repository settings has an "App settings ↗" link, but App settings has nothing that goes the other way.

## What Changes

- **Connect an account from a remote.** Each HTTPS remote whose provider GitLane can connect gets an action in its Account row. It reads **Connect <Provider> account…** when no account matches the remote. When the dropdown is shown, it reads **Connect another…**. The action opens App settings → Accounts on that provider's connect view.
- **Return to the repository.** When App settings was opened from that action, the window shows **← Back to <repo>**. The link closes App settings and reopens Repository settings on the remotes section. If exactly one new account that matches the remote's host appeared in the meantime, and the remote had no account bound, that account is bound to the remote.
- **Cancel the identity pick.** The expanded identity list gets a **Cancel** button and a **+ New identity…** link, which hands off to App settings → Identities → new. Escape collapses the list without closing the window. Cancelling leaves the current identity unchanged.
- **App settings → Repository settings link.** When a repository is open, the App settings sidebar shows a **THIS REPOSITORY · <repo> ↗** entry. It closes App settings and opens Repository settings. With no repository open, the entry is hidden.

## Capabilities

### New Capabilities
- `chrome/settings-navigation`: how the global App settings window and the repo-scoped Repository settings window link to each other: hand-offs, return, and the account connect entry point. Also covers dismissing the inline identity picker.

### Modified Capabilities
None. `accounts/transport` keeps its rules for resolving credentials. This change only adds a way to reach the existing connect flow.

## Non-goals

- Connecting a provider inline inside Repository settings. The connect UI stays in one place, App settings → Accounts.
- Merging the two windows into one, or redesigning either window's layout.
- Any change to how a remote authenticates, how an account is resolved, or how identities are written to git config.
- Contextual in-panel links in Accounts or Identities beyond the sidebar entry.
- SSH remotes, and hosts GitLane can't connect (other forges). These keep their current note and get no connect action.

## Impact

- `src/store/ui/settings.ts`: a transient `settingsReturn` hand-off record (repo-scoped origin). It is never persisted.
- `src/components/chrome/SettingsModal.tsx`: the repository sidebar entry and the Back link.
- `src/components/chrome/repo-settings/remotes-panel/RemoteAccountPicker.tsx` and `remoteAccountOptions.ts`: the connect action and the mapping from provider to connect intent.
- `src/components/chrome/repo-settings/RepoSettingsModal.tsx`: on return, auto-bind a single new matching account.
- `src/components/chrome/settings/identity-panel/CommitAsZone.tsx`: Cancel, Escape through the existing `useEscapeOwner`, and New identity.
- Patterns reused: the existing `openAccountsSettings(intent)` and `openIdentitiesSettings({ kind: "new" })` hand-offs, the `goGlobal` close-then-open pattern in `RepoSettingsModal`, and `useEscapeOwner` in `overlays/dialogs/frame.tsx`.
- Secrets/auth/IPC: no secret is touched. The hand-off carries only a remote name and a list of non-secret account ids. Binding goes through the existing `setRemoteAccount` (a `git remote set-url` username), which is unchanged.
