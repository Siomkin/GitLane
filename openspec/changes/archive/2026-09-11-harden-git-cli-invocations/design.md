## Context

See `proposal.md` — Why. The engine for everything here is the **git CLI write layer**; no libgit2
read path and no `forge::context()` provider changes. No command is added or changed, so the
four-layer IPC contract is untouched: no `commands/<domain>.rs` entry, no `generate_handler!` line, no
`git/types/` struct, no `src/lib/api/` wrapper. The one frontend edit is a guard in
`src/store/selection.ts`; no other Zustand store is involved and no folder-module split is due (every
file touched is inside the size ceiling).

Two structural facts shape the approach:

- **There is exactly one place every git subprocess is built.** `git/write/cli/command.rs` has
  `git_command` (with `-C <repo>`) and `git_command_bare`, and every runner — buffered, stdout-only,
  raw-bytes, env, stdin-piped, and the worktree-scoped OS-string pair — goes through one of them.
  A guarantee installed there holds for all of them, including call sites written later.
- **`git_output` applies the caller's env after `git_command` returns**, then re-runs
  `clear_repository_local_env`. That ordering is load-bearing for the identity fix and is the reason
  the six ident variables cannot simply be appended to `REPOSITORY_LOCAL_ENV_VARS`.

The audit's evidence, repros, and the per-group reports live in the session scratchpad; the findings
this change acts on are restated in the tasks, each with the observation that proves it.

## Goals / Non-Goals

**Goals:**

- Push every environment-dependence defect to the single construction site, so the fix is one edit
  rather than one per caller and cannot be forgotten by the next caller.
- Correct the partial-staging anchor without changing who applies patches — `git apply` keeps that
  job.
- Leave a regression test behind for each fix that fails before it, since the whole finding class
  exists because the current tests use pristine repositories with one change and default config.

**Non-Goals:**

- Reworking `patch_staging` into a different mechanism (for example, generating a full rewritten
  blob and using `hash-object`/`update-index`). The anchor is a numeric off-by-N; the smaller correct
  change is to compute it from the index side.
- Neutralising every user config knob that could theoretically affect git. Only knobs with a
  demonstrated wrong-output path are pinned; a broad `-c` blocklist is speculative and would have to
  be maintained against future git releases.
- Adding a translation layer so localized git text can still be classified.

## Decisions

### Pin the locale globally and delete the opt-in runner, rather than adding opt-in call sites

`cli/stable_diagnostics.rs` exists so a caller that pattern-matches git's output can request
`LC_ALL=C`. Four call sites use it. The audit found matches on git's human text at roughly a dozen
more, across conflict classification, stash outcome detection, push rejection handling, worktree
state, and clone progress — that is, the opt-in was the exception and the bug was the rule.

Pinning `LC_ALL=C`/`LANG=C` in `git_command` and `git_command_bare` makes every one of those sound at
once, removes ~25 lines plus two re-exports, and simplifies the four existing callers back to the
plain runners. Net deletion, and a call site added next year is correct by default.

*Alternative considered:* add the stable runner at each found site. Rejected — it is more code, it
leaves the default unsafe, and it fixes only the sites this audit happened to reach.

*Preferred spelling:* `LC_MESSAGES=C` with `LC_ALL` and `LANGUAGE` removed, rather than a blanket
`LC_ALL=C`. Both give English git text from one site. The difference is what **hooks** inherit: git
itself treats paths as bytes, so `LC_CTYPE` is irrelevant to the output GitLane parses — but a hook is
an arbitrary program, and a Ruby or older-Python linter that reads a non-ASCII file can raise under a
`C` ctype when it worked before. Pinning only the message category leaves the user's ctype alone.
`LC_ALL` and `LANGUAGE` must be cleared for this to hold, since both outrank `LC_MESSAGES`. Verify
against the pinned 2.36 build with catalogs before settling on it; fall back to `LC_ALL=C` and record
the hook consequence if it does not hold on both platforms.

*Accepted consequence:* git's own error text is always English. GitLane's UI has no i18n library and
is English-only, so this is consistent rather than a regression, and the copy users usually see is
GitLane's own classified message.

### Clear the identity variables in `git_command`, not in `REPOSITORY_LOCAL_ENV_VARS`

`REPOSITORY_LOCAL_ENV_VARS` is git's own `rev-parse --local-env-vars` list, and
`clear_repository_local_env` is called **twice**: once while building the command and once inside
`git_output` *after* the caller's `envs` have been applied. That second call is what makes the list
authoritative against a caller that forwards a routing variable.

The squash replay deliberately passes `GIT_AUTHOR_NAME`/`EMAIL`/`DATE` through `run_git_env_stdout` to
preserve each replayed commit's original author. Adding the ident variables to
`REPOSITORY_LOCAL_ENV_VARS` would therefore wipe exactly the pins the replay depends on, silently
re-authoring rewritten history to the current user. Clearing them in `git_command` (before caller
envs are applied) removes the inherited value while leaving a deliberate pin intact.

*This ordering is the single most dangerous detail in the change* and gets its own verification task.

### Pin `log.showSignature=false` with `-c` rather than adding `--no-show-signature` per call

Six call sites parse `git log` output; one of them (the squash replay's `log -1 --format=...`) fails
outright when signature text is prepended, and the rest silently gain junk records. A single `-c`
pin in `git_command` covers all of them and any future `log` caller. `-c` is placed immediately after
`-C <repo>`, before the subcommand, which leaves existing caller-supplied `-c` arguments and
`--literal-pathspecs` prefixes working unchanged.

The `--oneline` preview callers additionally pass `--no-decorate`, because `log.decorate` adds ref
names to the same line that is shown to the user as a commit subject.

### Restore content anchoring for single-line staging instead of patching the arithmetic

`single_line_range` emits a zero-context fragment whose new-side start is the displayed `new_no`.
`git apply --cached --unidiff-zero` resolves that number against the image it is modifying, which is
the index, not the worktree the number was measured in. With zero context there is no text to
re-anchor against, so git applies wherever the number points and exits 0.

The fix is to emit the **full hunk with its context**, neutralizing the changes the user did not
select: an unselected `+` line is dropped, an unselected `-` line is demoted to context. `--unidiff-zero`
then goes away. This is what `git add -p` does when it splits a hunk, and it makes git locate the
change by surrounding text, which is the only anchor that is correct in both directions.

*Alternative considered and demoted:* correct the anchor arithmetic per direction (stage-add uses
`previous_old_no + 1`, and unstage swaps the header fields before git computes the position). It is a
smaller diff, and it does fix the reproduced cases, but it keeps every fragment matching by position
in an image the caller has to reason about, and it has to be right separately for four
direction/kind combinations. The audit found a deletion case where a duplicate of the deleted line
sits further down and git's nearest-match picks the wrong occurrence, which is exactly the class of
failure that position-matching invites and content-matching cannot have. Hunk staging already uses
the content-anchored form and was verified correct as the control on the same repositories, so this
also collapses two mechanisms into one. Kept as a documented fallback in the tasks.

### Read patch bytes with the raw runner

`apply_hunk`/`apply_line` read the source diff with `run_git`, which concatenates stderr after stdout,
trims, and decodes lossily. All three are wrong for a patch, and all three were reproduced: a clean
filter's stderr warning lands inside the hunk body and makes the operation report a stale hunk
forever; the trim removes the CR from the diff's last line so staging the last line of a CRLF file
silently drops it; and a non-UTF-8 byte on the written side is staged as a replacement character.

The lossy decode deserves particular note because the existing stale-content gate cannot catch it:
the displayed diff is decoded through the same conversion, so both sides agree on the replacement
character and the comparison passes. The guard that was designed to fail safe is blind to exactly
this corruption.

`run_git_stdout_raw` already exists for this and is used by the NUL-delimited parsers, so the read
side is a one-line change. The write side is not: `cli/stdin.rs`'s `run_git_with_input` takes `&str`,
so a bytes variant is needed before the patch can reach `git apply` intact. That is the only new
surface this change adds to the CLI layer.

### Refuse mixed cherry-pick and revert selections instead of resuming a dropped remainder

The backend splits a mixed merge/non-merge selection into one git invocation per same-mergeness run.
A conflict in run 2 returns an error; the sequencer is gone by the time the user continues, so run 3
never happens and nothing reports it. Tracking and resuming a remainder across an interactive
conflict resolution means persisting operation state across app restarts — a large feature for a
selection the UI need not offer in the first place. Refusing the mixed batch up front (frontend guard
plus a backend check, since the backend must not trust the frontend) is a few lines and removes the
failure mode.

## Risks / Trade-offs

- **The identity-variable placement is reversible only by reading `git_output`'s ordering.** A future
  refactor that moves the clearing into `clear_repository_local_env` would silently re-author replayed
  commits. → A test asserts that a replay preserves original authors *while* a conflicting
  `GIT_AUTHOR_EMAIL` is set in the child environment, so the ordering is pinned by a failing test
  rather than a comment.
- **The locale pin is inherited by hooks and credential helpers.** A hook is an arbitrary program: a
  Ruby script (`Encoding.default_external` follows the locale) or an older Python linter can raise on
  non-ASCII content under a `C` ctype that it read fine before. → This is why the preferred spelling
  pins only `LC_MESSAGES` and leaves `LC_CTYPE` alone; the fallback to `LC_ALL=C` carries this risk
  and the task says to record it explicitly if taken. Hook *output* is surfaced verbatim and never
  parsed, so English hook messages are the only intended behavioural change.
- **The anchor fix could be wrong in the reverse direction.** Staging and unstaging resolve against
  different images. → Both directions get their own regression test with a second pending change in
  the file; the fallback design (full hunk with neutralized changes) is recorded above.
- **`--cleanup=whitespace` changes committed bytes for users who relied on `commit.cleanup=strip`
  trimming GitLane's messages.** → GitLane composes the message itself from two fields; there are no
  comment lines to strip, so the only behavioural difference is that a `#`-leading line the user
  typed now survives, which is the intent.
- **The audit reached five module groups; the forge CLI boundary was not audited.** → Recorded as a
  non-goal and left in the backlog below rather than implied to be clean.

## Migration Plan

No data, config, or on-disk format changes; nothing to migrate and nothing to roll back beyond
reverting a commit. The work is split so each task is independently shippable and independently
revertable, ordered by severity: the three silent-wrong-result fixes first, the chokepoint second
(it is one commit touching one file plus the four simplified callers), the remaining per-call fixes
last.

## Backlog — audit findings deliberately not in scope

Recorded so the next reader does not re-derive them:

- A stash is refused outright when the index holds an intent-to-add entry; git's raw error is passed
  through instead of a clear "unstage it first".
- Replaying a commit whose author name is empty fails with git's `empty ident name` error.
- The squash path writes `ORIG_HEAD` before its compare-and-swap, so a lost race clobbers the previous
  `ORIG_HEAD` value.
- `hash-object` hashes a symlink's target rather than the link when deciding whether a restore would
  overwrite, so the confirmation appears for a symlink that already matches and a dangling link
  errors instead. Fails safe either way.
- The reset preview degrades an unknown mode to "mixed" while the write rejects it.
- `merge-base` on unrelated histories surfaces a raw exit-code message instead of "these histories are
  unrelated".
- Branch deletion allowlists git's generic fatal exit code when removing the branch config section, so
  a malformed config reads as a successful cleanup.
- Shallow-clone behaviour of the fast-forward gate was not reproduced.
- The `gh`/`glab`/`origin` subprocess boundary was not part of this audit.
