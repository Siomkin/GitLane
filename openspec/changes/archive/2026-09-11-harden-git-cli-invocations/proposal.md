## Why

A five-group audit of every real-`git` invocation in `src-tauri/src/git/write/` found defects that
are invisible in the test suite because every existing test runs against a pristine repository with
one change at a time and a default `~/.gitconfig`. Four are silent-wrong-result bugs: staging a
single line writes it to **the wrong place in the index** whenever another pending edit sits above
it; the patch is read through a lossy, trimming, stderr-merging runner, so staging the last line of a
CRLF file drops its carriage return and a non-UTF-8 byte is staged as a replacement character; a user
with `commit.cleanup=strip` loses a `#`-leading summary line; and an inherited `GIT_AUTHOR_EMAIL`
overrides the identity card that GL-130 exists to pin, producing a hybrid author whose signature UID
no longer matches — the exact "Unverified commits, protected branch rejects the push" failure this
project already documents.

The staging defects deserve emphasis because the guard meant to catch them cannot: the displayed diff
is decoded through the same lossy conversion as the patch, so the stale-content comparison sees
matching text on both sides and lets the corruption through. The rest are correctness gaps that surface on ordinary
input: a merged branch whose remote was deleted cannot be deleted, every HEAD-leased operation
breaks when a tag shares the checked-out branch's name, `log.showSignature=true` turns signature text
into fake reflog entries, and a mid-batch conflict silently drops the remainder of a cherry-pick
selection.

The common root is that the write layer trusts the user's git environment. Four defects disappear at
a single chokepoint — the one place every subprocess is built, `git/write/cli/command.rs` — and
that is where this change puts them, rather than patching each call site.

No Jira key yet; create a `GL` task at apply time and reference it in the branch and commits.
Touches **Rust only** (`src-tauri/src/git/write/`, `src-tauri/src/git/mod.rs`) plus its tests, and one
small frontend guard for the mixed cherry-pick selection. No IPC command signature, type, or wrapper
changes.

## What Changes

**Chokepoint — deterministic subprocess environment** (`git/write/cli/command.rs`, one site, covers
every runner):

- Pin `LC_ALL=C`/`LANG=C` for every git invocation, and **delete** `cli/stable_diagnostics.rs` with
  its two runners. Four call sites opt in today; every other site that matches git's human text is
  wrong on a localized git. GitLane's own UI is English-only (no i18n library), so a per-call opt-in
  is a bug generator and a global pin is a net deletion.
- Clear the six `GIT_AUTHOR_{NAME,EMAIL,DATE}` / `GIT_COMMITTER_{NAME,EMAIL,DATE}` variables so an
  inherited value cannot beat the `-c user.*` identity pin. These go in `git_command`, **not** in
  `REPOSITORY_LOCAL_ENV_VARS`, because `git_output` re-applies that list *after* the caller's env and
  would wipe the squash replay's deliberate author pins.
- Pin `-c log.showSignature=false` so signature verification text can never enter a `git log` parse.

**Per-call correctness fixes**:

- `patch_staging/extract.rs` — anchor a single-line patch by the index-side position instead of the
  displayed worktree line number.
- `commits/create.rs` — pass `--cleanup=whitespace` so the user's `commit.cleanup` cannot rewrite a
  message GitLane composed.
- `write/head.rs` (and `remotes/push.rs`) — read HEAD with `symbolic-ref -q HEAD` and strip
  `refs/heads/` instead of `--short`, whose shortening is ambiguous when a tag shares the name.
- `branches/delete.rs` — when a branch's configured upstream no longer resolves, fall back to `HEAD`
  for the merged check, which is what `git branch -d` itself does.
- `history/cherry_pick.rs`, `history/revert.rs` — refuse a mixed merge/non-merge selection up front
  rather than splitting it into runs whose remainder is dropped after a conflict.
- `patch_staging/apply.rs`, `patches.rs` — read patch bytes with the raw runner and pin the
  remaining `git diff` formatting knobs, so a patch is never truncated by a trim or mangled by a
  lossy UTF-8 decode.
- `worktrees/lifecycle.rs`, `branches/create.rs` — finish the branch-tracking fix shipped in
  `fe41e45e`. It stopped a new branch inheriting the base it started from, but `add_worktree`'s
  new-branch arm has no guard at all, and the guard it did add misses the short `origin/develop`
  spelling. Both leave `branch.<n>.merge` pointing at the base, which is what a later push uses as
  its destination. The condition moves into one shared helper so the two callers cannot diverge
  again.

**Regression tests** — each fix lands with a test that fails before it: an unstaged edit above the
staged line, `commit.cleanup=strip` set in the test repo, an inherited `GIT_AUTHOR_EMAIL`, a tag
shadowing the checked-out branch, a branch whose upstream is `[gone]`, and an SSH-signed commit with
`log.showSignature=true`.

## Capabilities

### New Capabilities

- `changes/patch-staging`: staging or unstaging one hunk or one line applies exactly the selected
  change at exactly the selected position, regardless of other pending edits in the same file, and
  refuses rather than guessing when the patch no longer matches.
- `platform/git-invocation`: every git subprocess GitLane runs is insulated from the user's
  environment — stable message locale, no inherited commit identity, no config-dependent decoration
  of machine-read output — so parsing and classification cannot depend on how the user configured
  git.

### Modified Capabilities

- `history/write-ops`: adds requirements for commit-message fidelity, HEAD identification under an
  ambiguous refname, deleting a merged branch whose upstream is gone, and reporting the unapplied
  remainder of a batch cherry-pick or revert.

## Impact

- Rust: `git/write/cli/command.rs` (the chokepoint), `cli/stable_diagnostics.rs` (deleted) and its
  four callers (`conflict_resolution.rs`, `remotes/transport.rs`, `history/commit_runner.rs`),
  `lifecycle/clone.rs` (its own locale pins become redundant),
  `patch_staging/{extract,apply,runners}.rs`, `commits/create.rs`, `write/head.rs`,
  `remotes/push.rs`, `branches/{delete,create}.rs`, `worktrees/lifecycle.rs`,
  `history/{cherry_pick,revert}.rs`, `patches.rs`.
- Frontend: one guard in `src/store/selection.ts` so a mixed merge/non-merge batch is not offered.
- Tests: `git/write/tests/{staging/lines,commits,branches,history,recovery}` gain the regression
  cases above; the signing test uses SSH signing with a generated temp key so it runs offline on all
  three CI platforms.
- Secrets/auth/IPC risk: **none**. No command gains or changes a parameter, no type or wrapper moves,
  and no code path added here touches a token. The identity fix *removes* an environment channel that
  could silently redirect authorship; it does not read, store, or transmit credentials.
- Behaviour visible to users: git's own error text is now always English. That matches GitLane's
  English-only UI, and the classified copy users normally see (`src/lib/gitError.ts`) is unchanged.
- Pattern to copy: `cli/command.rs`'s existing `clear_repository_local_env` treatment is the model
  for the env and `-c` pins; `git/write/tests/support.rs`'s `TempRepo` is the model for the
  regression tests.

## Non-goals

- No libgit2 read-layer audit. The read side is only touched where a write fix needs it (none
  currently).
- No rewrite of hunk/line staging into a different mechanism; the anchor is corrected, `git apply`
  still owns patch application.
- No change to what `git` binary is found, the 2.36.0 floor, or the version gate.
- No forge (`gh`/`glab`/`origin`) invocation changes; that subprocess boundary was out of scope.
- The audit's LOW findings are deliberately left out of scope and recorded in `design.md` so the next
  reader does not re-derive them: intent-to-add entries refusing a stash, an empty author name
  failing a replay, `ORIG_HEAD` written before a compare-and-swap, `reset -q HEAD` being ambiguous
  with a file named `HEAD`, `hash-object` following a symlink, and `preview_reset` degrading an
  unknown mode to "mixed".
