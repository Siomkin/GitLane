# Proposal

## Why

When a local feature branch was created outside GitLane from a differently-named remote base (e.g., `git checkout -b feat/mcp-apps-subscriptions origin/develop`), Git's default `branch.autoSetupMerge=true` sets `origin/develop` as its upstream. Today, GitLane's `shouldPublishNamesake` guard in `src/lib/branchSync.ts` only redirects Push to the Publish prompt when the branch is `upToDate` with that mismatched upstream — so as soon as the user makes a commit (`ahead`) or both branches move (`diverged`), clicking Push or Commit & Push bypasses the Publish prompt and pushes directly onto `origin/develop` via `branch.<name>.merge`. Worse, when diverged, both the toolbar and the branch context menu's Danger zone offer leased Force push onto `origin/develop`, and a namesake on an unrelated remote (e.g. `backup/feat`) bypasses the guard altogether. Meanwhile, triangular fork workflows (`branch.<name>.pushRemote` / `remote.pushDefault` differing from the upstream remote) already push safely to `<pushRemote>/<local>` and must not be hijacked into publishing onto the parent remote. Finally, opening a PR from an unpublished or mismatched-upstream branch must publish only to the remote that matches the PR's resolved forge repository, and refuse cross-repository heads cleanly where GitLane only supports same-repository PRs.

## What Changes

- **Extend and tighten `shouldPublishNamesake` (`src/lib/branchSync.ts`)**:
  - Match all live synced states (`upToDate`, `ahead`, `behind`, `diverged`) where the mismatched upstream resolves, even when a same-named remote-tracking ref already exists on the target remote (so ordinary Push and Force push never silently target a shared base via `branch.<name>.merge`).
  - Preserve explicit triangular push-remote routing: return `false` whenever `branch.pushRemote` differs from the branch's upstream remote (`branch.<name>.pushRemote` or `remote.pushDefault`), because `push_destination` already targets `<pushRemote>/<local>`.
  - Resolve both the default publish target and explicit remote from a single helper that prefers the backend-resolved `upstreamRemote`, so a longer slashed remote name cannot hijack `origin/feat/base`.
- **Suppress leased force-push in both toolbar and branch menu (`src/lib/branchSync.ts`, `src/components/chrome/overlays/menus/branchContextMenuPolicy.ts`, `src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx`)**:
  - Disable `canForcePush` in `currentBranchSyncView` and hide `Force push (with lease)…` in the branch menu's Danger zone whenever `shouldPublishNamesake` is true.
- **Align Commit & Push publish prompt default (`src/features/changes/commit-modal/commitComposerModel.ts`)**:
  - Pass `publishUsesConfiguredUpstream(info, branches)` into `defaultPublishTarget` (matching `useActionBarModel.ts` and `quickActions.tsx`) so Commit & Push pre-fills `<remote>/<local>`.
- **Expose `prRemote` on `RepoForge` and guard Create-PR auto-publish (`src-tauri/src/git/forge/resolution/pr_remote.rs`, `src-tauri/src/git/forge/resolution.rs`, `src-tauri/src/git/types/repo.rs`, `src/lib/api/git/types/repo.ts`, `src/features/pull-requests/create-pr/useCreatePrForm.ts`, `src/features/pull-requests/create-pr/CreatePrDialog.tsx`)**:
  - Resolve the configured git remote whose effective push URL matches the active PR provider's resolved repository (`pr_remote: Option<String>` / `prRemote?: string | null` on `RepoForge`, pure libgit2 read).
  - In `useCreatePrForm` / `CreatePrDialog`, publish an unpublished or namesake-publish head branch to `${prRemote}/${head}` only when the branch's publish destination matches `prRemote`; when cross-repository heads are unsupported (mismatched push/tracking remote or no remote pushing to the resolved PR repository), block PR submission and explain why inline instead of pushing to the wrong remote or passing a bare `--head`.
- **Update and add Rust and frontend unit/component tests** covering all scenarios above.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `history/write-ops`: Extend mismatched-upstream namesake publish rules across `upToDate`, `ahead`, `behind`, and `diverged` (scoped to the target remote, preserving triangular push remotes, and suppressing both toolbar and branch-menu force-push), and narrow the existing diverged force-push requirement so the two do not contradict.
- `pull-requests/create`: Require Create-PR auto-publish to match the resolved PR target repository and block cross-repository heads with an inline explanation when unsupported.

## Non-goals

- Changing Rust `push_destination` / `push_branch` (`src-tauri/src/git/write/remotes/push.rs`): the write layer intentionally honours `branch.<name>.merge` when a user or test explicitly pushes a configured divergent upstream.
- Implementing cross-repository / fork pull request creation (`--head owner:branch`) across forge providers.
- Changing branch creation (`create_branch` / `add_worktree`): `#418` already passes `--no-track` for differently-named remote starts created inside GitLane.
- Changing behavior when a branch tracks a same-named upstream.

## Impact

- **Jira**: None.
- **Processes touched**: Frontend (`src/`) and Rust read DTO (`src-tauri/src/git/forge/resolution/`, `src-tauri/src/git/types/repo.rs`) — additive optional field `prRemote` on existing `RepoForge` returned by `repo_forge`. No new Tauri command or handler entry.
- **Secrets / Auth / IPC**: No secrets or credentials are touched. `pr_remote` is a pure libgit2 read of local git config and remote URLs (no network, no tokens), matching `forge::service::context`'s repository resolution. Publish continues to route through existing `publish_branch` IPC with server-side per-remote credential resolution.
- **Existing patterns to follow**: `shouldPublishNamesake` / `publishUsesConfiguredUpstream` in `src/lib/branchSync.ts`; `src-tauri/src/git/forge/resolution/gh_resolved.rs` for pure libgit2 forge-config resolution; `BranchContextMenuPolicy` for pure menu policy derivation.
- **Files touched**:
  - `src-tauri/src/git/forge/resolution/pr_remote.rs` (new submodule)
  - `src-tauri/src/git/forge/resolution.rs`
  - `src-tauri/src/git/types/repo.rs`
  - `src/lib/api/git/types/repo.ts`
  - `src/lib/branchSync.ts` and `src/lib/branchSync.test.ts`
  - `src/components/chrome/overlays/menus/branchContextMenuPolicy.ts` and `src/components/chrome/overlays/menus/branchContextMenuPolicy.test.ts`
  - `src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx`
  - `src/components/chrome/overlays/branchMenu.test.tsx` and `src/components/chrome/action-bar/ActionBar.test.tsx`
  - `src/features/changes/commit-modal/commitComposerModel.ts` and `src/features/changes/commit-modal/commitComposerModel.test.ts`
  - `src/features/pull-requests/create-pr/useCreatePrForm.ts`, `src/features/pull-requests/create-pr/CreatePrDialog.tsx`, and `src/features/pull-requests/create-pr/CreatePrDialog.test.tsx`
