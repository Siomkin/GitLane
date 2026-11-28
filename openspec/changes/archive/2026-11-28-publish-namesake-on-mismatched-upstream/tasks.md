# Tasks

## 1. Rust Forge PR-Remote Resolution & DTO (`src-tauri/`)

- [x] 1.1 Create `src-tauri/src/git/forge/resolution/pr_remote.rs` (pure libgit2 read) that resolves the active PR provider's target `(authority, project)` and returns the first configured remote whose effective push URL matches it, or `None` when no remote matches.
- [x] 1.2 Wire `pr_remote` into `forge::summary` in `src-tauri/src/git/forge/resolution.rs` and add `pub pr_remote: Option<String>` to `RepoForge` in `src-tauri/src/git/types/repo.rs`.
- [x] 1.3 Add `prRemote?: string | null` to `RepoForge` in `src/lib/api/git/types/repo.ts` (and `prRemote: z.string().nullish()` to `repoForgeSchema` in `src/lib/api/schemas/repo.ts`).

## 2. Branch Sync & Force-Push Policy (`src/lib/` & `src/components/`)

- [x] 2.1 Update `shouldPublishNamesake` in `src/lib/branchSync.ts` to cover `upToDate`, `ahead`, `behind`, and `diverged`, return `false` for triangular push remotes (`branch.pushRemote !== upstreamRemote`), and scope the namesake lookup to the branch's target remote.
- [x] 2.2 Update `currentBranchSyncView` in `src/lib/branchSync.ts` so `canForcePush` is `false` whenever `publishNamesake` is `true`.
- [x] 2.3 Add `canForcePush` (`isLocal && isCurrent && !publishNamesake`) to `BranchContextMenuPolicy` in `src/components/chrome/overlays/menus/branchContextMenuPolicy.ts` and gate `"Force push (with lease)…"` in `src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx` on `canForcePush`.

## 3. Commit & Push and Create-PR Callers (`src/features/`)

- [x] 3.1 Update `publishPromptDetails` in `src/features/changes/commit-modal/commitComposerModel.ts` to pass `publishUsesConfiguredUpstream(info, branches)` into `defaultPublishTarget`.
- [x] 3.2 Update `useCreatePrForm` in `src/features/pull-requests/create-pr/useCreatePrForm.ts` and `CreatePrDialog` in `src/features/pull-requests/create-pr/CreatePrDialog.tsx` to publish unpublished and mismatched-upstream head branches only when the publish destination matches `forge.prRemote`, and disable submission with an inline explanation when cross-repository heads are unsupported.

## 4. Tests

- [x] 4.1 Add Rust unit tests in `src-tauri/src/git/forge/resolution.rs` covering `summary().pr_remote` for single-remote, `gh-resolved = base` multi-remote, `gh-resolved = owner/other` with no matching remote, and distinct `pushurl` cases.
- [x] 4.2 Update `src/lib/branchSync.test.ts` to cover `ahead`, `behind`, and `diverged` mismatched-upstream publish (`canForcePush: false`), triangular fork workflows (`pushRemote !== upstreamRemote` staying on ordinary push), and two-remote namesake isolation (`backup/feat` not bypassing `origin/develop`).
- [x] 4.3 Add tests in `src/components/chrome/action-bar/ActionBar.publish.test.tsx`, `src/components/chrome/overlays/menus/branchContextMenuPolicy.test.ts`, and `src/components/chrome/overlays/branchMenu.test.tsx` verifying both toolbar Force push and branch-menu `"Force push (with lease)…"` are absent on a diverged mismatched-upstream branch while Push opens the Publish prompt, and that a triangular fork branch keeps ordinary Push.
- [x] 4.4 Add a test in `src/features/changes/commit-modal/commitComposerModel.test.ts` verifying `publishPromptDetails` pre-fills `<remote>/<local>` when ahead of a differently-named upstream.
- [x] 4.5 Add tests in `src/features/pull-requests/create-pr/CreatePrDialog.test.tsx` covering matching-remote auto-publish on a mismatched-upstream branch, mismatched-remote/fork cross-repo blocking, and `prRemote: null` blocking.

## 5. Verification

- [x] 5.1 Run `bun check`, `bunx tsc --noEmit`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, and `bun run cycles`.
- [x] 5.2 Run `(cd src-tauri && cargo check && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo clippy --all-targets --no-default-features --features agent -- -D warnings && cargo test)`.
