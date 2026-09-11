## 1. Single-line staging anchor (PR 1 — highest severity)

Evidence: index holds `L1..L10`; the worktree inserts `X` after `L2` (left unstaged) and `Y` after
`L7`; staging only `Y` emits `@@ -7,0 +9,1 @@` and `git apply --cached --unidiff-zero` exits 0 with
`Y` landing after `L8`. The correct header `@@ -7,0 +8,1 @@` places it after `L7`.

- [x] 1.1 Add a failing test in `src-tauri/src/git/write/tests/staging/lines.rs` that commits ten
      lines, inserts one line after line 2 and one after line 7, stages only the second, and asserts
      the **staged blob content** (not merely that the diff contains the line) equals the ten lines
      with the new line directly after `L7`; verify it fails against today's code
      Two further failing cases were reproduced and must also be covered, because they show the
      defect is not limited to additions: a **deletion** whose file contains a duplicate of the
      deleted line further down (git's nearest-match tries forward first and removes the wrong
      occurrence), and the **unstage** direction (`--reverse` swaps the header fields before git
      computes the position, so an unstaged deletion is reinserted after the wrong neighbour).

- [x] 1.2 Add the mirror tests for the other three combinations: stage-delete with a duplicate line
      below the selection, unstage-delete, and unstage-add. Assert full staged blob content in each;
      record which fail today
- [x] 1.3 In `src-tauri/src/git/write/patch_staging/extract.rs`, emit the **full hunk with its
      context** and neutralize the changes the user did not select (drop an unselected `+` line,
      demote an unselected `-` line to context), then drop `--unidiff-zero` from
      `patch_staging/runners.rs`. This is how `git add -p` splits a hunk, and it restores content
      anchoring so git locates the change by surrounding text rather than by a line number that was
      computed against a different image. Verify 1.1 and 1.2 pass and the five existing
      `staging/lines.rs` tests still pass
- [x] 1.3a Not needed — 1.3 succeeded. (Original: only if 1.3 proves impractical, fall back to correcting the anchor arithmetic per
      direction (stage-add → `previous_old_no + 1` on the new side, unstage-delete →
      `previous_new_no + 1` on the old side). Note this is the weaker fix: it is direction-dependent
      and leaves zero-context fragments matching by position, so record explicitly that 1.2's
      duplicate-line case still passes before accepting it
- [x] 1.4 Strengthen the existing added-line and deleted-line tests to assert full staged blob
      content rather than `contains(...)`, so a future misplacement cannot pass; verify
      `cargo test staging::lines` is green

## 2. Commit message and identity fidelity (PR 2)

Evidence: `git -c commit.cleanup=strip commit -m '#77 Fix the crash' -m 'Body explaining it'` records
the subject `Body explaining it`. `GIT_AUTHOR_EMAIL=env-leak@example.test git -c user.name=PinnedCard
-c user.email=pinned@card.test commit` records `PinnedCard <env-leak@example.test>`.

- [x] 2.1 Add a failing test in `src-tauri/src/git/write/tests/commits/` that sets
      `commit.cleanup=strip` in the test repo and commits a `#`-leading summary with a description,
      asserting the subject is the summary; verify it fails today
- [x] 2.2 Add `--cleanup=whitespace` to the `commit` argv in
      `src-tauri/src/git/write/commits/create.rs` (both the plain and `--amend` paths); verify 2.1
      passes and the existing commit tests are unchanged
- [x] 2.3 Add a failing test that runs a commit with a conflicting `GIT_AUTHOR_EMAIL` and
      `GIT_COMMITTER_NAME` in the child environment while an identity is pinned, asserting both
      author and committer come from the pin; verify it fails today
- [x] 2.4 Add a second failing test asserting a **squash replay** still preserves each original
      commit's author *while* a conflicting `GIT_AUTHOR_EMAIL` is set — this is the test that pins
      the ordering described in `design.md` and must fail if the clearing is later moved into
      `REPOSITORY_LOCAL_ENV_VARS`
- [x] 2.5 In `src-tauri/src/git/write/cli/command.rs`, `env_remove` the six
      `GIT_AUTHOR_{NAME,EMAIL,DATE}` and `GIT_COMMITTER_{NAME,EMAIL,DATE}` variables inside
      `git_command` and `git_command_bare` — **not** in `clear_repository_local_env`, which
      `git_output` re-applies after the caller's env; verify 2.3 and 2.4 both pass

## 3. Subprocess chokepoint: locale and log decoration (PR 3)

Evidence: `git -c log.showSignature=true log -1 --format='%H%x1fAUTHOR:%an' HEAD` in this repository
prints signature verification text where the record should be. German catalogs translate
`CONFLICT (%s)`, `could not apply %s`, and `Saved working directory` and defeat the classifier.

- [x] 3.1 Add a failing test that creates an SSH-signed commit with a generated temp key
      (`ssh-keygen -N ""`, `gpg.format=ssh`, `gpg.ssh.allowedSignersFile`, so it runs offline on all
      three CI platforms), sets `log.showSignature=true`, and asserts the recovery reflog entries
      parse to the expected number of records with non-zero timestamps; verify it fails today
- [x] 3.2 Add a failing test that a below-tip squash succeeds with `log.showSignature=true` and a
      signed commit above the squashed range; verify it fails today
- [x] 3.3 In `src-tauri/src/git/write/cli/command.rs`, pin the message locale and
      `-c log.showSignature=false` in `git_command` and `git_command_bare`. Add the `-c` with
      `cmd.arg`, **not** by prepending to the args slice callers hand to `finish` — that slice is what
      names the operation in the "git … failed (exit code N)" fallback, and a config pin must not
      appear there. Place it after `-C <repo>` and before the subcommand. For the locale, prefer
      `env_remove("LC_ALL")` + `env_remove("LANGUAGE")` + `env("LC_MESSAGES", "C")` over a blanket
      `LC_ALL=C`, so hooks keep the user's ctype (see the hook-runtime risk in `design.md`); confirm
      against the pinned 2.36 build with catalogs that `LC_MESSAGES=C` alone yields English while
      `LANGUAGE` is unset. Verify 3.1 and 3.2 pass
- [x] 3.4 Delete `src-tauri/src/git/write/cli/stable_diagnostics.rs`, its `mod` declaration, and its
      two `pub(super) use` re-exports in `cli.rs`; switch the four callers
      (`conflict_resolution.rs` ×2, `remotes/transport.rs`, `history/commit_runner.rs`) back to
      `run_git_env` / `run_git_env_redacted`. Also delete the now-redundant `LC_ALL`/`LANG` pins in
      `lifecycle/clone.rs:54-55`, which the chokepoint supersedes; verify `cargo check` passes, the
      clone progress tests still pass, and no reference to `stable_diagnostics` remains
- [x] 3.5 Add `--no-decorate` to the `--oneline` preview calls in `recovery/reset.rs:89`,
      `recovery/branches.rs:42`, and `recovery/force_push.rs:53`/`:66` so `log.decorate` cannot add
      ref names to a line shown as a commit subject; verify the recovery preview tests pass
- [x] 3.6 Record in `docs/rules/architecture-rules-rust.md` that every git subprocess is
      locale-pinned at the construction site, so a future caller does not reintroduce a per-call
      opt-in; verify the sentence names `cli/command.rs`

## 4. Patch byte fidelity (PR 4)

`apply.rs:21` and `:37` read the patch source with `run_git`, which concatenates stderr after stdout,
trims, and decodes lossily. All five consequences were reproduced on both git 2.36.0 and 2.54.0; two
corrupt silently at exit 0, three block the operation permanently:

- A non-UTF-8 byte **on the side being written** stages a replacement character instead of the
  original bytes, at exit 0. The same byte in a context line fails closed. The stale-content gate
  cannot catch it, because the displayed diff is decoded with the same lossy conversion.
- The trim removes the CR from the diff's final line, so staging the last line of a CRLF file drops
  that CR at exit 0.
- A CRLF file whose hunk is not at end of file becomes permanently unstageable.
- A clean filter that writes to stderr (the git-lfs class) has its warning folded into the hunk body,
  so the operation reports "that hunk changed on disk" forever.
- Trailing whitespace on the diff's last line produces the same permanent false rejection.

- [x] 4.1 Add failing tests for the two silent-corruption cases: staging the last line of a CRLF
      file (assert the staged blob keeps every CR) and staging a hunk whose added line holds a
      non-UTF-8 byte (assert the original bytes are staged). Add a third for the stderr case using a
      clean filter that writes a warning, asserting the operation succeeds rather than reporting a
      stale hunk; verify all three fail today
- [x] 4.2 Add a bytes variant of `run_git_with_input` in `src-tauri/src/git/write/cli/stdin.rs`,
      which currently takes `&str` and so cannot carry a faithful patch; verify it writes the bytes
      unaltered
- [x] 4.3 In `patch_staging/apply.rs`, read the source diff with `run_git_stdout_raw` and pipe the
      extracted patch through the new bytes runner; adjust `extract.rs` to operate on bytes; verify
      4.1 passes
- [x] 4.4 Pin the formatting knobs on the three `git diff` exports in `patches.rs:117`/`:140`/`:165`
      (`--no-ext-diff`, `--no-textconv`, `--no-color`, `--src-prefix=a/`, `--dst-prefix=b/`) to match
      what `patch_staging/runners.rs` already pins. Each was reproduced producing a file no
      `git apply` will take: `diff.noprefix=true` drops the prefixes, and `diff.external` replaces
      the diff with the tool's output entirely while still reporting success
- [x] 4.5 Pin `-c diff.noprefix=false` and `--no-cover-letter` on the two `format-patch` calls
      (`patches.rs:25`/`:60`). With `format.coverLetter=true` the mailbox starts with a placeholder
      cover letter and `git am` answers "Patch is empty" and applies nothing; `diff.noprefix` breaks
      `git am` at the 2.36.0 floor, though 2.54 forces prefixes. Verify the `tests/patches.rs` suite
      passes with both settings present in the test repo
- [x] 4.6 Add the missing `--` to `git reset -q HEAD` in `staging.rs:69`, which aborts with
      "ambiguous argument" when the worktree root holds a file named `HEAD`; verify unstage-all
      succeeds in a repo containing such a file

## 5. Branch delete and HEAD identification (PR 5)

Evidence: after a merged branch's remote counterpart is deleted and pruned, `%(upstream)` still names
`refs/remotes/origin/feat`, `merge-base --is-ancestor` exits 128, and GitLane refuses — while
`git branch -d feat` deletes it. With branch `latest` and tag `latest`, `symbolic-ref --short -q HEAD`
returns `heads/latest` while libgit2's shorthand returns `latest`.

- [x] 5.1 Add a failing test that pushes a branch with an upstream, merges it, deletes the remote
      branch, prunes, and deletes the local branch without forcing, asserting it succeeds; verify it
      fails today
- [x] 5.2 In `src-tauri/src/git/write/branches/delete.rs`, fall back to `HEAD` for the merged check
      when the configured upstream does not resolve; verify 5.1 passes and the genuinely-unmerged
      refusal test still passes
- [x] 5.3 Add a failing test that creates a tag sharing the checked-out branch's name and then
      commits, stashes, and resets, asserting none reports that HEAD changed; verify it fails today
- [x] 5.4 In `src-tauri/src/git/write/head.rs`, replace `symbolic-ref --short -q HEAD` with
      `symbolic-ref -q HEAD` plus a `refs/heads/` prefix strip, and apply the same change at
      `remotes/push.rs:126`; verify 5.3 passes and the detached-HEAD tests still report no branch

## 6. Batch cherry-pick and revert (PR 6)

- [x] 6.1 Add a test asserting a mixed merge/non-merge cherry-pick selection is refused with a
      message naming the constraint, and the same for revert; verify both fail today
- [x] 6.2 Reject a mixed selection in `src-tauri/src/git/write/history/cherry_pick.rs` and
      `revert.rs` before any git invocation; verify 6.1 passes
- [x] 6.3 Add the matching guard in `src/store/selection.ts` so the UI does not offer the action for
      a mixed selection, and a test in the adjacent `*.test.ts`; verify `bun run test` passes

## 7. Branch upstream inheritance — finish the fe41e45e fix (PR 7)

`fe41e45e` stopped `create_branch` making a new feature track the base it started from, by passing
`--no-track` when the start point is a differently-named remote-tracking ref. Two sibling paths were
missed, both verified against a local bare remote:

- `add_worktree`'s `(Some(branch), Some(start))` arm has no guard at all:
  `git worktree add -b feat-wt ../wt refs/remotes/origin/develop` leaves
  `branch.feat-wt.merge refs/heads/develop`.
- `remote_tracking_branch` only strips `refs/remotes/`, so the short spelling bypasses the shipped
  guard: `git branch feat-short origin/develop` leaves `branch.feat-short.merge refs/heads/develop`.

Both feed `push_destination`, which builds the push refspec from `branch.<n>.merge` — so a push on
the new branch updates the base and never publishes the branch.

- [x] 7.1 Add failing tests: creating a worktree with a new branch from a differently-named remote
      ref leaves no `branch.<n>.merge`, and creating a branch from the short `origin/develop` form
      leaves none either; verify both fail today
- [x] 7.2 Add the passing counterpart test that a same-named start (`topic` from `origin/topic`)
      still tracks, so the guard is not widened into a blanket `--no-track`
- [x] 7.3 Extend `remote_tracking_branch` in `src-tauri/src/git/write/branches/create.rs` to accept
      the short `<remote>/<branch>` spelling as well as the fully-qualified one, resolving the remote
      name against the repository's remote list so a branch named `origin/x` is not misread; verify
      7.1's second case and 7.2 pass
- [x] 7.4 Move the guard into one shared helper and call it from both `create_branch` and
      `add_worktree`'s `-b` arm, rather than copying the condition — the copy is what let this
      diverge; verify 7.1's first case passes and `grep -rn "no-track" src-tauri/src/git/write/`
      shows a single decision site
- [x] 7.5 Confirm `--no-track` parses on `worktree add` at the 2.36.0 floor (it does; re-verify with
      the pinned build) and that the existing worktree tests still pass

## 8. Definition of done (every PR)

- [x] 8.1 `(cd src-tauri && cargo check)` and `(cd src-tauri && cargo test)` pass
- [x] 8.2 `(cd src-tauri && cargo fmt --all -- --check)` and
      `(cd src-tauri && cargo clippy --all-targets --all-features -- -D warnings)` pass
- [x] 8.3 `bunx tsc --noEmit`, `bun run test`, and `bun run build` pass (PR 6 only needs these for the store guard; run them regardless)
- [x] 8.4 `bun run sizes` passes — confirm no touched file crossed the ceiling, in particular
      `patch_staging/extract.rs` after the byte conversion
- [ ] 8.5 In `bun run tauri dev` against a real repository, confirm by hand: staging one line with
      another pending edit above it lands correctly, a commit keeps a `#`-leading summary, and a
      branch whose remote was deleted can be deleted without forcing
- [ ] 8.6 Create the `GL` Jira task for this change and reference its key in the branch name, commit
      subjects, and PR titles
