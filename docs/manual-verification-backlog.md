# Manual verification backlog

Every in-app (`bun run tauri dev`) check that a change listed as its definition of done
and that has not been run yet. They are grouped into three sittings by the setup they need,
not by change, so each setup is prepared once. Tick a line here and the matching task in
the change's `tasks.md` together, or file a bug.

From 2026-10-16 on, a change is not archived while one of its manual tasks is unticked.
See [architecture-rules.md §3](rules/architecture-rules.md).

## Sitting A: a scratch repository, no accounts (about 45 min)

Setup: `git init` a scratch repo with a few commits, a second branch, a symlink, and a
`.pre-commit-config.yaml`. A clone of any public repo works for the remote-tracking items.

- [ ] Drop a remote feature branch onto `develop`; the feature moves, not develop. Rebase a
  checked-out local feature onto `develop`; at `↑n ↓1`, Force push with lease makes the two
  pills coincide. *(archive/2026-09-02-fix-remote-feature-rebase 4.2)*
- [ ] Commit with a pinned identity and amend it; squash two commits; squash a range. A stale
  expected head is refused with the usual error copy.
  *(archive/2026-09-15-bundle-write-command-requests 2.4)*
- [ ] Stage and unstage a single line; run soft, mixed and hard resets, with and without
  expectations. *(bundle-write-command-requests 3.3,
  archive/2026-09-11-harden-git-cli-invocations 8.5)*
- [ ] Squash another branch while the current branch has dirty work: the target is
  rewritten and the current state is unchanged. *(archive/2026-09-05-squash-other-branch 3.2)*
- [ ] Run `git commit` in a terminal; the open repo refreshes.
  *(archive/2026-09-15-close-size-ratchet-gap 4.1)*
- [ ] Pull with a conflict; hand off with a partly staged file; open a range of more than
  500 commits and see the truncation notice. *(archive/2026-10-09-align-sibling-behaviour 5.2)*
- [ ] Stash, pop, discard all and hard reset all behave as before.
  *(archive/2026-10-09-dedupe-backend-helpers 5.2, git half)*
- [ ] A conflict in `.pre-commit-config.yaml` opens the conflict workspace; restore a
  symlinked file. *(archive/2026-10-09-harden-git-core 6.2, local half)*
- [ ] Edit a file between the hard-reset preview and confirm; the stale-lease refresh
  prompt appears. *(archive/2026-10-09-type-the-ipc-and-write-boundary 5.2, first half)*
- [ ] Open a terminal, switch worktree in place; the old shell is gone. Escape closes a
  navigator-raised delete-worktree dialog. *(archive/2026-10-09-fix-audit-runtime-bugs 8.2,
  local half)*
- [ ] Open Settings from a clone error and press Escape; after a restart, worktree recents
  are grouped; with the accent set to Blue and then Red, check the graph and the conflict
  editor. *(archive/2026-10-09-harden-frontend-views 7.2)*
- [ ] Click through Settings (Accounts, Identity, Remotes), the branch navigator and a
  remove-worktree dialog; nothing regressed.
  *(archive/2026-10-09-prune-dead-code-and-duplicates 6.2)*
- [ ] Force an overlay render error (a temporary throw, never committed): the error card
  appears, Close and Escape dismiss it, and `~/Library/Logs/space.gitlane.desktop/frontend-errors.log`
  gets an entry. Do the same for the toast layer: the next toast renders again.
  *(archive/2026-10-17-fix-create-pr-dialog-crash 6.3, plus the Phase 0 overlay reset)*
- [ ] Reveal a `-dash` worktree in Finder; toggle the beta channel and run an update check.
  *(archive/2026-09-04-tighten-tauri-security-config 4.2, local half)*

## Sitting B: GitHub, two `gh` accounts (about 30 min)

Setup: two github.com accounts logged into `gh`, a private test repo both can push to, and
a PR containing an external image and a `javascript:` link.

- [ ] Bind the *inactive* account to the remote (`https://<inactive>@github.com/...`).
  Push, fetch and pull all authenticate as it; `gh auth status` is unchanged afterwards.
  Then sign the bound account out of `gh`: push fails with an auth error instead of going
  through as the active account.
  *(archive/2026-10-17-pin-gh-transport-account 4.3)*
- [ ] Launch with `GH_TOKEN=<dummy>`, bind an account and fetch: it succeeds as the bound
  account. Never use a real token as the dummy.
  *(archive/2026-09-15-pin-bound-account-authority 3.3)*
- [ ] Bind an account in the Remotes picker: the remote URL username updates and the PR list
  reloads. Merge a PR; the graph refreshes. *(archive/2026-09-18-break-store-import-cycles 3.4,
  GitHub half)*
- [ ] Open the PR create dialog; reviewers are listed. *(fix-audit-runtime-bugs 8.2, PR half)*
- [ ] Open the PR with the external image and `javascript:` link; each matches its spec
  scenario. *(tighten-tauri-security-config 4.2, PR half)*
- [ ] Sign in through `gh` web sign-in. *(archive/2026-09-18-decouple-auth-flows-from-apphandle
  4.3, GitHub part)*
- [ ] Delete a merged PR's remote branch that is already gone. *(harden-git-core 6.2, remote half)*

## Sitting C: GitLab, Bitbucket and Cursor Origin (about 45 min)

Setup: a GitLab test host (and a self-hosted one with a ported remote, if available), a
Bitbucket repo with a stored token, an Origin repo, and a dummy Bitbucket OAuth client id.
Never complete authorization against a production OAuth client.

- [ ] Open one GitHub, GitLab, Bitbucket and Origin repo each: the PR tab, branch menu,
  Remotes legend and Accounts rows agree. *(archive/2026-10-09-declare-forge-capabilities-once 6.2)*
- [ ] Fetch a GitLab repo in `providerToken` mode ten times with no auth failure; open a
  self-hosted ported remote's provider links. *(archive/2026-10-09-harden-forge-providers 7.2)*
- [ ] On the Bitbucket repo, "Open a pull request…" from a branch menu: the title is the last
  commit subject, "Opening as" shows, typing works, and the window never blanks.
  *(archive/2026-10-17-fix-create-pr-dialog-crash 6.2)*
- [ ] An Origin repo still lists its PRs. *(dedupe-backend-helpers 5.2, Origin half)*
- [ ] Fetch with a URL-less bound remote. *(type-the-ipc-and-write-boundary 5.2, second half)*
- [ ] Provider-token sign-in; OAuth sign-in, then switch repo tabs before it completes.
  *(break-store-import-cycles 3.4, provider half)*
- [ ] GitLab device-flow sign-in, Bitbucket PKCE sign-in, cancel mid-flow. *(decouple-auth-flows-from-apphandle 4.3)*
- [ ] Start Bitbucket sign-in, then
  `curl -s "http://127.0.0.1:<port>/callback?error=x"`: the app keeps waiting; then cancel.
  *(archive/2026-09-15-harden-provider-oauth-sign-in 5.4)*
- [ ] On a GitLab host, save a PAT under login `42`, then complete native sign-in: both cards
  remain and the PAT still authenticates. *(harden-provider-oauth-sign-in 5.5)*

## Outside `tauri dev`

- [ ] On Linux with distro xdg-utils: Files panel → Reveal and Open both launch.
  *(tighten-tauri-security-config 8.3)*
- [ ] The next beta tag with a Mac runner online: `preflight` starts and the macOS leg
  exports signing env only. *(archive/2026-09-05-restore-release-workflow-validity 4.2)*
- [ ] With an ACP agent configured, Draft on staged changes still arrives.
  *(archive/2026-09-15-harden-acp-git-read-gate 4.3)*
