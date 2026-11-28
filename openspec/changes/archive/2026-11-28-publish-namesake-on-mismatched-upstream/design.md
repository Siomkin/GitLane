# Design

## Context

GitLane's write layer (`src-tauri/src/git/write/remotes/push.rs`) resolves `push_destination` from `branch.<name>.merge` only when the resolved push remote equals `branch.<name>.remote` (`upstream_remote`). When `branch.<name>.pushRemote` or `remote.pushDefault` points to another remote (triangular/fork workflow), `push_destination` already ignores `branch.<name>.merge` and pushes to `<pushRemote>` → `refs/heads/<branch>`.

When `pushRemote === upstreamRemote` and `branch.<name>.merge` points at a base branch such as `refs/heads/develop`, an explicit `<oid>:refs/heads/develop` refspec bypasses Git's `push.default=simple` guard. `#418` added `shouldPublishNamesake` in `src/lib/branchSync.ts`, but left five gaps:
1. It only triggered on `upToDate`, leaving `ahead`, `behind`, and `diverged` on direct `push_branch` / `force_push`.
2. `currentBranchSyncView` and the branch menu (`destructiveActions.tsx`) still offered leased force-push when diverged.
3. It did not check `branch.pushRemote` vs `upstreamRemote`, so triangular fork setups could be hijacked into publishing onto the parent remote and rewriting tracking.
4. Its namesake check searched all remotes (`shortName(item) === branch.name`), so an unrelated `backup/feat` bypassed the guard.
5. `publishPromptDetails` in `commitComposerModel.ts` ignored `publishUsesConfiguredUpstream`, and `useCreatePrForm.ts` had no way to verify that a branch's publish destination matched the PR's independently resolved forge repository (`forge::service::context`).

## Goals / Non-Goals

**Goals:**
- Route ActionBar Push, Branch Context Menu Push, and Commit & Push to the Publish prompt (`<target-remote>/<local>`) for mismatched-upstream branches across `upToDate`, `ahead`, `behind`, and `diverged` (even if `<target-remote>/<local>` already exists), respecting triangular push remotes and deriving both prompt default and explicit remote from `upstreamRemote`.
- Hide leased force-push in both the toolbar and the branch context menu's Danger zone whenever `shouldPublishNamesake` is true.
- Expose `prRemote` and `prRemotes` on `RepoForge` via a pure libgit2 read so `CreatePrDialog` auto-publishes to any remote alias matching the PR's target repository, and blocks true cross-repository heads with an inline explanation.

**Non-Goals:**
- Modifying Rust `push_destination` or `push_branch` (explicit divergent upstream pushes remain supported).
- Implementing cross-repository / fork PR head creation (`owner:branch`).
- Adding new Tauri commands, new JS/Rust dependencies (`docs/tauri-plugin-decisions.md` unchanged), or modifying Zustand store shapes or graph layout.

## Decisions

### 1. Engine & IPC
- **Write engine**: Existing git CLI write path (`publish_branch` via `useRepo.getState().publishBranch`). No write-layer changes.
- **Read engine**: Pure libgit2 read in a new submodule `src-tauri/src/git/forge/resolution/pr_remote.rs` called from `forge::summary` (`resolution.rs`), populating an additive optional field `pr_remote: Option<String>` on `RepoForge` (`src-tauri/src/git/types/repo.rs` ↔ `src/lib/api/git/types/repo.ts`, camelCase `prRemote`).
  - **Four IPC layers**: Impl (`forge/resolution/pr_remote.rs` + `resolution.rs`) → Command+handler (`commands/remotes.rs::repo_forge` + `lib.rs`, unchanged signature) → Types (`git/types/repo.rs::RepoForge`) → TS api (`src/lib/api/git/types/repo.ts::RepoForge`).
- **Zustand stores**: None modified. Pure policy helpers live in `src/lib/branchSync.ts`, `src/components/chrome/overlays/menus/branchContextMenuPolicy.ts`, and `src/features/changes/commit-modal/commitComposerModel.ts`. No folder-module split is due.

### 2. `shouldPublishNamesake` & default target rules (`src/lib/branchSync.ts`)
- Live synced states covered: `"upToDate" | "ahead" | "behind" | "diverged"` (excluding `"noRemote"`, `"noUpstream"`, `"staleUpstream"`, `"unknown"`).
- **Triangular push-remote guard**: Resolve `upstreamRemote` from `branch.upstreamRemote ?? remoteNameForUpstream(upstream, remoteNames)`. If `branch.pushRemote` is defined and `branch.pushRemote !== upstreamRemote`, return `false` — pushes already route to `branch.pushRemote` under `branch.name`, so prompting to publish would both target the wrong remote and overwrite `branch.<name>.remote`/`.merge`.
- **No existing-namesake bypass**: Any non-triangular branch tracking a differently-named upstream (`tracked !== branch.name`) routes through the Publish prompt and hides leased Force push even if `<targetRemote>/<local>` already exists, because Rust `push_destination` would otherwise push or force-push onto `branch.<name>.merge`.
- **Unified default target resolution**: `resolveDefaultPublishTarget` derives both the pre-filled `remote/branch` string and the explicit remote passed to `publish_branch` from the same source, preferring backend `upstreamRemote` (ignoring `.`) so a longer slashed peer remote like `origin/feat` cannot hijack `origin/feat/base`.

### 3. Force-push suppression in toolbar and branch menu
- `currentBranchSyncView` (`src/lib/branchSync.ts`): `canForcePush: !publishNamesake && canForcePush(sync)`.
- `BranchContextMenuPolicy` (`src/components/chrome/overlays/menus/branchContextMenuPolicy.ts`): add `canForcePush: isLocal && isCurrent && !publishNamesake`.
- `dangerZoneItems` (`src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx`): gate `"Force push (with lease)…"` on `canForcePush` instead of `isCurrent`.

### 4. `RepoForge.prRemote` and Create-PR cross-repository guard
- **`src-tauri/src/git/forge/resolution/pr_remote.rs`**:
  - Given `&Repository` and the detected `ForgeKind`, resolve the PR provider's target `(authority, project)` using the same local resolvers as `provider.resolve_repository`:
    - `ForgeKind::GitHub` → `github_project_in(repo)` (honours `remote.<name>.gh-resolved`)
    - `ForgeKind::GitLab` / `ForgeKind::CursorOrigin` → `project_for_in(repo, kind)`
    - `ForgeKind::Bitbucket` → `bitbucket_repo_in(repo)` (on `bitbucket.org`, matching `BitbucketProvider::resolve_repository`)
    - Other / non-PR forges → `None`
  - Walk `ordered_remote_names(repo, default_remote_name(repo).as_deref())` and collect every remote (`pr_remotes_for` → `prRemotes`, with `prRemote` set to the first match) whose effective push URLs all parse to the same `(authority, project)` (ASCII case-insensitive host and path comparison). If none matches (e.g., `gh-resolved = parent/repo` in a fork clone with only `origin`), `prRemotes` is empty and `prRemote` is `None`.
- **`prTargets.ts`, `useCreatePrForm.ts`, and `CreatePrDialog.tsx`**:
  - Read `prRemote = forge?.prRemote` and `prRemotes = forge?.prRemotes` (`undefined` means legacy/unpopulated fixture or unknown forge; `null`/empty means a PR-capable forge whose resolved repository has no matching configured push remote).
  - Accept any remote in `prRemotes` (so same-repository remote aliases like `mirror` alongside `origin` are allowed and publish to `<alias>/<head>`), while blocking true cross-repository/fork remotes not in `prRemotes`.
  - When blocked (`crossRepoError: string | null`): `publishTarget` is `null`, `canSubmit` is `false`, and `CreatePrDialog` renders the inline explanation (e.g., `"Cross-repository pull requests are not supported — push <head> to <prRemote> or change the pull request repository."` / `"Cross-repository pull requests are not supported — no configured remote pushes to the resolved pull request repository."`).

### 5. File-size ceiling check
- `src-tauri/src/git/forge/resolution.rs` currently has 355 non-test lines; extracting `pr_remote.rs` keeps `resolution.rs` well under 400 lines.
- `src/lib/branchSync.ts` (230 lines), `src/components/chrome/overlays/menus/branchContextMenuPolicy.ts` (206 lines), `src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx` (112 lines), `src/features/changes/commit-modal/commitComposerModel.ts` (243 lines), `src/features/pull-requests/create-pr/useCreatePrForm.ts` (329 lines), and `src/features/pull-requests/create-pr/CreatePrDialog.tsx` (187 lines) all remain safely under 400 lines.

## Risks / Trade-offs

- **Intentional non-triangular differently-named upstream**: If a user deliberately tracks `origin/shared-b` from `local-a` without a separate `pushRemote` and without `origin/local-a`, Push opens the Publish prompt pre-filled with `origin/local-a`; the user can still type `origin/shared-b` if intended.
- **Triangular fork with `pushRemote=origin` and `prRemote=upstream`**: Push works directly to `origin/feat`, while Create PR explicitly explains that cross-repository PRs are not supported rather than silently publishing to `upstream` or failing with a cryptic forge error.
- **Existing tests**: `src/lib/branchSync.test.ts` has `"still pushes to the mismatched upstream when ahead of it"`, which encodes the buggy `#418` behavior and will be replaced with `ahead`/`behind`/`diverged` publish tests plus triangular-fork and two-remote regression cases.
