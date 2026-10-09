# Design

## Context

See proposal.md (Why). Every item below comes from the 2026-09-25 code-smell audit. Each
P0/P1 citation was reopened in the current tree before this change was written. The full
evidence per finding (`path:line`, the failing input, and the consequence) is under
**Findings** at the end, so the change does not depend on the audit's scratch files. IDs are
`A<slice>-<n>` from the audit.

## Goals / Non-Goals

**Goals:** restore the specified or sibling-proven behaviour at each site with the smallest
edit, and leave one regression test per fix.

**Non-Goals:** the forge capability table, typed IPC enums, and duplicate cleanup are other
audit changes. Nothing here adds a dependency, a store, or a new IPC command.

## Decisions

1. **Engine per fix.** None of these fixes changes which engine an operation uses. `reveal`
   and `open_path` stay OS openers in Rust. The compare diff stays libgit2 (`git/status`).
   The reviewer lookup stays `gh api` through the existing `run_gh` boundary.
2. **xdg-open (A1-1, A1-14).** Drop `--` rather than probe the xdg-utils version.
   `shell::require_absolute` already guarantees the operand starts with `/`, so nothing is
   lost. Collapse `git/write/reveal.rs`'s OS table into `crate::shell::reveal`, keeping
   reveal.rs's Linux "open the parent directory" rule and its worktree guard. Alternative
   considered: keep both tables and patch each one. Rejected, because the two tables
   already disagree on Linux (A1-14).
3. **Reviewer path (A2-1).** Add `rest_repo_path(&GithubRepository) -> "repos/{owner}/{name}"`
   next to `repo_selector` and use it in `reviewer_candidates`, `list_stacks` and
   `merge_async_path`. Keep the silent-empty fallback for a 403, but pin the path with an
   argument-builder test.
4. **Compare rename (A3-1).** Generalise `working/new_path.rs::renamed_diff` to take the
   comparison as a closure (tree→tree or tree→workdir) and call it from
   `compare_file_diff` on a looks-added result. This is the fix `file_diff` got; no new
   module.
5. **Tab drop (A7-1).** Extract one `dropRepoTab(path)` in `src/store/repoTab/`. It ends the
   tab lifetime, unwatches, calls `closeRepoTerminals` and `forgetTerminalView`, and prunes
   tabInfo and recents. `closeRepo`, `publishSwitch`'s replaced source,
   `retireDeadWorktreeTab`, both `fallbackFromRemovedWorktree` branches, and
   `locateMissingRepo` call it. It reaches `useTerminals` through the existing one-shot
   `getState()` it already uses. The import direction is unchanged.
6. **pty_write (A3-3).** Give each session one writer thread fed by an `std::sync::mpsc`
   channel. `pty_write` stays sync and only looks up the session's `Sender` under the map
   lock and sends the bytes. The blocking PTY write runs on the writer thread, so it never
   runs on the UI thread or under the shared lock. The single consumer keeps keystrokes in
   the order typed. Alternative considered: `async` + `blocking` with a per-session writer
   `Arc<Mutex<…>>`. Rejected, because the frontend fires writes without awaiting them, and
   pool threads would reorder them. `pty_write` stays in `SYNC_BY_DESIGN` as an enqueue.
7. **Retry owner (A7-2).** `toastWriteError(owner, error, retry)` uses `owner.path` for
   `repoPath` and suppresses the retry when `!ownerIsCurrent(get, owner)`. This is the guard
   `repoWriteActions/files.ts` already uses.
8. **Escape (A8-1).** Re-export `overlayOpenDialogs` from `store/ui.ts` and derive
   `navOverlayBlocking` (and the two settings windows' `overlayBlocking`) from it, instead
   of a hand-kept five-field list.
9. **Author badge (A4-2).** Map thread comments through `prs.ts`'s `uiAuthor` so they carry
   `login` and `initials`, and compare logins. Keying `PrMeta` chips by login comes along
   in the same edit.
10. **Markdown (A5-1).** Use native list markers (`list-disc` / `list-decimal`, plain
    `li`). The hand-drawn "•" span goes away.
11. **Conflict wording (A6-1).** Build the row suffix from `sideLabels` (the
    `oursSub`/`theirsSub` the row already receives), so one module owns the
    operation-aware names.
12. **acp_agents (A3-4).** Make the read three-state: NotFound seeds and saves, any other
    error seeds without saving, Ok parses. This matches the existing comment.
13. **History results (A3-5).** Build both search and range results with one
    `history_result(&Commit)` (committer time, the shared `short_oid`). Fix the "author
    time" doc comments on `CommitNode.timestamp` and `StashEntry.base_timestamp`.
14. **bench:graph (A4-1).** Point the filter at `git::graph::tests::support::benchmark_fixture`
    with `--exact`, and exit non-zero when cargo reports `0 passed`.

Stores touched: `repo` (tab lifecycle, write actions) and `ui` (overlay selector). No
folder-module split is due. Check `bun run sizes` after editing
`repoWriteActions/staging.ts`.

## Risks / Trade-offs

- [Suppressing the retry for a switched-away repo hides a retry the user might want] →
  The toast still shows the error with the owning repo's name. The user can switch back
  and repeat the action.
- [Disposing shells on an in-place worktree switch kills a running process the user
  expected to keep] → That process was already unreachable (no UI). The spec makes
  disposal explicit. If keeping shells is ever wanted, it needs a UI to reach them first.
- [Dropping `--` for xdg-open] → Safe only while operands are absolute. The existing
  `require_absolute` guard stays on every path, and a test pins that.

## Findings

### A1-1 — `xdg-open -- <path>` always fails: Reveal / Open-with-default-app are broken on Linux
- Priority: P0
- Smell: Duplicate Code (three hand-rolled OS-opener tables) hiding a runtime bug
- Where: src-tauri/src/git/write/reveal.rs:123-125, src-tauri/src/git/write/open_path.rs:113-114 (also out-of-slice src-tauri/src/shell.rs:239-243, whose comment says "`--` is the documented operand terminator")
- Evidence: Both call `Command::new("xdg-open").arg("--").arg(path)` / `.args(["--"]).arg(path)`. xdg-utils' `xdg-open` (verified in upstream `scripts/xdg-open.in` v1.2.1 lines 571-587 and Debian 1.1.3 lines 494-510) parses args with `case "$parm" in -*) exit_failure_syntax "unexpected option '$parm'"`. It has no `--)` arm, so `--` is rejected. Input: any Linux `reveal_in_file_manager` / `open_path_default` / `reveal_path` call. Result: exit 1, surfaced as "File manager exited with exit status: 1" / "xdg-open exited with …". (Not run on Linux here; the conclusion comes from the upstream script.)
- Consequence: On Linux, the Files panel's Reveal and Open, and the onboarding "Reveal" action, never work. No test spawns xdg-open, so CI can't catch it.
- Fix: Remove Dead Code (the `--`). `shell::require_absolute` already guarantees the operand can't start with `-`. While there, have `write/reveal.rs::reveal_path` call `crate::shell::reveal` so one table remains (see #14).
- Confidence: high

### A1-14 — Two OS "reveal" implementations that already behave differently
- Priority: P3
- Smell: Duplicate Code (Alternative Classes with Different Interfaces)
- Where: src-tauri/src/git/write/reveal.rs:78-134 vs src-tauri/src/shell.rs:215-250 (used by commands/repo.rs:171 `reveal_path` and commands/files.rs:64 `reveal_in_file_manager` respectively); src-tauri/src/git/write/open_path.rs:88-124 is a third opener table
- Evidence: `reveal.rs` blocks on `.status()`, sets no augmented PATH, doesn't call `hide_console`, and on Linux opens the parent directory. `shell::reveal` spawns without waiting, sets PATH and `hide_console`, and on Linux passes the file itself (which opens it instead of revealing it). Both share the bug in #1.
- Consequence: A per-OS fix (GL-337's Windows hardening, #1) has to be made in two or three places, and the two Reveal buttons behave differently on the same OS.
- Fix: Extract Method. Keep one `shell::reveal(&Path)` with the Linux parent-directory rule, and have `write/reveal.rs` call it after its worktree guard.
- Confidence: high

### A2-1 — GitHub reviewer picker is always empty: collaborators path embeds the host
- Priority: P0
- Smell: Duplicate Code / Primitive Obsession (a "repo selector" string reused where an owner/name path is required)
- Where: src-tauri/src/git/forge/prs/mutations.rs:104-110, src-tauri/src/git/forge/cli/repo_selector.rs:7-12; correct siblings at src-tauri/src/git/forge/prs/stacks.rs:84 and :233
- Evidence: `let repo = repo_selector(repository);` gives `"{host}/{owner}/{name}"` (e.g. `github.com/octo/app`), then `format!("repos/{repo}/collaborators?per_page=100")` gives `repos/github.com/octo/app/collaborators`. `gh api` resolves the endpoint against the API root of `--hostname`, so that path is a 404. Line 107 turns every error into `Ok(Vec::new())` and line 110 turns a parse error into an empty list, so the failure is silent. `list_stacks` (stacks.rs:84) and `merge_async_path` (stacks.rs:233) build `repos/{owner}/{name}/…` correctly. The bug has been there since the function was added (184ceb71, GL-347; `repo_selector` already included the host then). No test covers `reviewer_candidates` or its path.
- Consequence: `pull_request_reviewer_candidates` (commands/github.rs:270) returns `[]` for every GitHub and GHES repo, so the create-PR dialog never offers reviewers. The code treats the empty result as "caller lacks push access", which hides the break.
- Fix: Extract Method. Add one `rest_repo_path(repository) -> "repos/{owner}/{name}"` helper next to `repo_selector`. Use it in `reviewer_candidates`, `list_stacks` and `merge_async_path`, and pin it with an argument-builder test like the others in prs/.
- Confidence: high

### A3-1 — Renamed file in the compare view opens as an all-added diff
- Priority: P0
- Smell: Sibling implementations that disagree (Duplicate Code, half-applied fix)
- Where: git/status/compare.rs:76-95 (`compare_file_diff`), git/status/diff.rs:67-73 (`literal_file_options`), git/status/compare.rs:41-50 (`compare_refs`), fixed copy at git/status/working.rs:326-342 + git/status/working/new_path.rs:27-58
- Evidence: `compare_refs` runs `diff.find_similar(None)` on the full diff, so a moved file is listed as one `R` row with small +/− counts. `compare_file_diff` builds the same diff with `literal_file_options(file)` (pathspec = only the new path). That drops the deleted source before `find_similar` runs, so nothing can pair and the delta comes back `Added` with every line as `+`. `working.rs:326-331` documents the same trap ("The pathspec above dropped any rename source, so a rename's new path can only come back looking like a whole-file add") and fixes it only for `file_diff` with `renamed_diff`. Callers that hit the broken path: `src/store/repoSelection/compare.ts:130`, `src/store/repoFileDiff.ts:75`, `src/store/repoSelection/commits.ts:44`.
- Consequence: Take a branch that renames `a.rs` → `b.rs` with a one-line edit, then compare it. The file list shows `R b.rs +1 −1`, but opening it shows the whole file as added. The pane contradicts the list, which is the exact bug GL-127/GL-114 fixed on the working tree.
- Fix: Extract Method / Parameterize Method. Generalise `new_path::renamed_diff` so it takes the comparison closure (tree→tree or tree→workdir) instead of the `staged` flag. Then call it from `compare_file_diff` when the result `looks_added`, the same way `file_diff` does.
- Confidence: high

### A3-3 — `pty_write` can freeze the UI thread and deadlock every terminal
- Priority: P1
- Smell: Rule breach (SYNC_BY_DESIGN "instant" contract) / Inappropriate lock scope
- Where: terminal.rs:200-215 (`write`), commands/terminal.rs:201-207 (sync `pty_write`), commands/registration_tests/thread_placement.rs:11-32 (list rationale: "returns in microseconds"), contrast terminal.rs:235-251 (`kill` deliberately releases the lock before the slow call)
- Evidence: `write` takes the global `Terminals` mutex, then calls `session.writer.write_all(data)` while still holding it. A PTY master write blocks once the slave's input queue is full (a few KB), which happens when the foreground program is not reading stdin. `pty_write` is a sync command, so this runs on the webview main thread.
- Consequence: Paste a multi-KB clipboard into a tab running `sleep 60` (or any program that isn't reading). The main thread blocks, so the whole app stops repainting. The held mutex also blocks `pty_kill`, `pty_resize`, `pty_spawn` and the other tabs' writes, so closing the tab can't rescue it until the program reads.
- Fix: Move the blocking write out of the lock and off the main thread. Store each writer as `Arc<Mutex<Box<dyn Write + Send>>>`, clone it under the map lock, release the lock, then write. Make `pty_write` `async` + `blocking` with the same Arc-clone shape `pty_spawn` already uses, and remove it from `SYNC_BY_DESIGN`.
- Confidence: medium-high

### A3-4 — acp_agents: a config that exists but can't be read is overwritten, contrary to the comment
- Priority: P1
- Smell: Misleading Comment hiding a data-loss path
- Where: acp_agents.rs:193-224 (`load_in`); comment at 196-198; save at 217-222
- Evidence: The comment says a non-NotFound read error "is also 'not first run' — but there is nothing to parse, so it seeds without saving, same as a corrupt file." The code maps every read error to `text = None`, and `None` goes to the first-run branch. That branch runs `migrate_from_terminal_agents_in(dir).unwrap_or_else(defaults)` and then `let _ = save_entries_in(dir, &entries)`. `save_entries_in` writes a tmp file and renames it over `acp-agents.json`.
- Consequence: If `acp-agents.json` exists but can't be read (permissions, a transient EIO on an external or synced volume, an AV lock on Windows) and the directory is writable, the user's hand-edited agent list is replaced with seeds. That is the exact destruction the module doc says was fixed for the corrupt-JSON case.
- Fix: Replace Nested Conditional. Make the read three-state (NotFound → first run + save; other error → seeds, no save; Ok → parse), so the no-save path is the code the comment already describes.
- Confidence: high

### A3-5 — Timestamp semantics: docs say "author", code uses committer time, and one wire type is built both ways
- Priority: P1
- Smell: Misleading Comments + sibling implementations that disagree (Duplicate Code)
- Where: git/types/graph.rs:47 (`CommitNode.timestamp` "Author time") vs git/graph/layout/build.rs:291 (`commit.time()` = committer). git/types/refs.rs:22 (`StashEntry.base_timestamp` "Author timestamp") vs git/write/stashes.rs:96-98 (`%ct` = committer). `HistorySearchResult` built at git/read/search.rs:243-255 (`timestamp: signature.when()` = **author**, `short_id` **8** chars) and git/read/range.rs:25-36 (`commit.time()` = **committer**, `short_id` `[..7]`)
- Evidence: The two producers of `HistorySearchResult` disagree on both fields. Search filters on committer date (search.rs:174-186, types/graph.rs:95-96) but reports author date. Short-id formatting exists in at least 9 hand-written copies (graph/layout/build.rs:278,301; read/range.rs:30; read/search.rs:245; status/history.rs:23; write/recovery/refs.rs:23; write/stashes.rs:146,171; write/stash_push.rs:156,168; write/restore_path.rs:146). Search is the only one that uses 8 characters.
- Consequence: For a rebased or cherry-picked commit, the search hit shows a different date and id length than the same commit in the PR range list and the graph, and a hit can show a date outside the `since`/`until` window the user filtered on. Anyone reading the type docs will assume graph and stash placement compare author times when they actually compare committer times.
- Fix: Extract Function. Add one `history_result(&Commit)` in `git/read` that both search and range use (committer time, 7-char id via one shared `short_oid`). Correct the two doc comments to "committer time".
- Confidence: high

### A4-1 — `bun run bench:graph` runs zero tests and exits 0
- Priority: P0 (broken today)
- Smell: Dead Code / stale reference (filter string drifted from the test it names)
- Where: scripts/run-graph-benchmark.ts:18; src-tauri/src/git/graph/tests/support.rs:46-48; src-tauri/src/git/graph/tests.rs:6; docs/graph-performance.md:42-43
- Evidence: the script runs `cargo test --release --lib git::graph::tests::benchmark_fixture -- --ignored --nocapture`. The test moved into `mod support` in 01e8a33f ("Bring the tree under the file-size ceiling"), so its real path is `git::graph::tests::support::benchmark_fixture`. libtest filters by substring; the old path is not a substring of the new one. Verified with the built test binary: `gitlane_lib-… --list --ignored` lists `git::graph::tests::support::benchmark_fixture`, and `gitlane_lib-… git::graph::tests::benchmark_fixture --ignored --list` prints `0 tests` with exit 0.
- Consequence: the documented graph benchmark (docs/graph-performance.md) prints nothing measured and "succeeds", so a perf regression check silently measures nothing.
- Fix: Rename/update the reference — point the filter at `git::graph::tests::support::benchmark_fixture` and pass `--exact`, and have the script fail when cargo's output reports `0 passed` so the next module move is loud.
- Confidence: high

### A4-2 — Review-thread "Author" badge compares display names against login-only comment authors
- Priority: P1 (misleading)
- Smell: Primitive Obsession (identity by display name) / sibling implementations disagree
- Where: src/features/pull-requests/ReviewThreads.tsx:142,158-160,175; src-tauri/src/git/forge/threads.rs:23; src/lib/prs.ts:28-30,164-167,257; src/features/pull-requests/PrMeta.tsx:73,82,117; src/features/pull-requests/PrConversation.tsx:45
- Evidence: `ThreadComment` does `const name = comment.author.name || comment.author.login` and `isAuthor = name === prAuthorName` with `prAuthorName={pr.author.name}`. The GitHub thread query fetches `comments{nodes{author{login} …}}` — no name — so a thread comment's `name` is always the login, while `pr.author.name` (from `gh pr list/view`, which returns `author{login,name}`) is the display name. Input: PR author `{login:"jdoe", name:"Jane Doe"}` replying in a thread → `"jdoe" === "Jane Doe"` is false → no Author badge. `prs.ts:28-30` states the rule this breaks ("display names aren't unique and can be empty on comment authors, so dedupe/compare on this [login], not `name`"). Same rule broken in `PrMeta.tsx` React keys (`key={r.name}`, `key={a.name}`, `key={p.name}` — two people with one display name collide), and `PrConversation.tsx:45` recomputes `initials(comment.author.name, comment.author.name)` instead of using the `comment.author.initials` that `uiAuthor` already computed from name+login.
- Consequence: on GitHub the Author badge effectively never shows for a PR author who has a display name; duplicate-name participants produce duplicate React keys.
- Fix: Replace Data Value with Object — compare `comment.author.login === pr.author.login` (map thread comments through `prs.ts`'s `uiAuthor` so they carry `login`/`initials` like every other PR person), key chips by `login`, and use `author.initials` in `PrConversation`.
- Confidence: high

### A5-1 — Markdown renders every ordered list as bullets
- Priority: P1 (visible today in every Markdown surface)
- Smell: Refused Bequest / misleading classes (component overrides break the list semantics it declares)
- Where: src/components/ui/Markdown.tsx:81-89
- Evidence: `li` is rendered as `<li className="flex gap-2.5 … marker:text-neutral-400"><span>•</span>…</li>` for *both* `ul` and `ol`. A `display:flex` list item has no `::marker` box, so `ol`'s `list-decimal` (line 82) never paints, and every item gets the hard-coded `•`. Input `1. a\n2. b\n3. c` renders as three bullets with no numbers. `ol`'s `flex-col gap-[5px]` (no `flex`) and `li`'s `marker:text-neutral-400` are dead classes. react-markdown is v10 (package.json:39), whose `li` component gets no `ordered`/`index` prop, so the component cannot tell the two lists apart. `Markdown.test.tsx` has no `<ol>` case.
- Consequence: numbered content loses its numbering in PR descriptions, review threads, README preview (FilePreview/MarkdownPreview) and AI-action output. The shipped "Test plan" AI action (`DEFAULT_AI_ACTION_TEST` in src-tauri/src/terminal_agents/defaults.rs, mirrored in src/store/commitAgentMessages.ts) explicitly asks for a "numbered Markdown test plan", and `AiActionsBody.tsx:87` renders it through this component, so step numbers disappear.
- Fix: Remove the hand-drawn bullet (Substitute Algorithm): `ul` → `list-disc pl-5`, `ol` → `list-decimal pl-5`, and a plain `li` with no `flex` or bullet span. That is fewer lines than today. Add an `<ol>` assertion to Markdown.test.tsx.
- Confidence: high

### A6-1 — The conflict file list labels deletions "by you/them" from raw ours/theirs, which is wrong during a rebase or carry
- Priority: P1
- Smell: Sibling implementations that disagree (duplicated side-labelling policy)
- Where: src/features/conflicts/ConflictFileRow.tsx:28-37 (`kindSuffix`), versus src/features/conflicts/conflict-workspace/conflictWorkspaceModel.ts:40-68 (`sideLabels`) and src/features/conflicts/ConflictEditor.tsx:248-258
- Evidence: `kindSuffix` maps `deletedSide === "ours"` to " · deleted by you" and anything else to " · deleted by them". `sideLabels` documents that git inverts ours/theirs during a rebase ("ours" is the commit being rebased onto, "theirs" is your commit) and during a carry. The editor card for the same file correctly says `Deleted on ${oursSub}`. The row also receives `oursSub`/`theirsSub`, but only its buttons use them. Input: a rebase with a modify/delete conflict where upstream deleted the file (stage 2 missing, so `deletedSide === "ours"`). The row says "deleted by you", while the editor says "Deleted on rebased onto (ours)". `ConflictFileRow.test.tsx` has no assertion on this text.
- Consequence: Mid-rebase, users see the opposite story in the list and may keep or drop the wrong version.
- Fix: Replace Magic Literal with Parameter. Build the suffix from `oursSub`/`theirsSub` (or a `deletedSideLabel(kind)` helper next to `sideLabels`), so one module owns the operation-aware wording.
- Confidence: high

### A7-1 — Tab-drop paths other than closeRepo leave live terminal PTYs with no UI
- Priority: P0 (broken today)
- Smell: Shotgun Surgery / sibling implementations that disagree
- Where: src/store/repoTab/closeRepo.ts:35-40 (the only caller of `closeRepoTerminals` + `forgetTerminalView`); src/store/repoLifecycle/publishSwitch.ts:83-95 (`replacedSource` — in-place worktree switch, GL-110); src/store/repoLifecycle/sideEffects.ts:59-65 (unwatches the replaced path, nothing else); src/store/repoMissing.ts:123-135 (`retireDeadWorktreeTab`); src/store/repoMissing.ts:185-237 and 244-259 (`fallbackFromRemovedWorktree`, both branches); src/store/repoLifecycleActions.ts:235-251 (`locateMissingRepo` re-keys stale→new path)
- Evidence: `closeRepo` documents that dropping a tab must call `useTerminals.getState().closeRepoTerminals(path)` "otherwise a background-repo close would leave shells running with no UI". The panes manager disposes a PTY only when its tab leaves `useTerminals.byRepo` (features/terminal/panes/usePaneReconciler.ts:66-70 builds `wanted` from `byRepo` alone; nothing in features/terminal reads `openPaths`). The five other sites that remove a path from `openPaths` each re-implement a different subset of "drop a tab" (`endTabLifetime`, `unwatchRepo`, `pruneTabInfo`, recents, persist) and none touches terminals or `terminalViewByRepo`. Concrete: open a terminal in worktree A, use "switch worktree" (in-place, `loadRepo(B, {replaceTab: A})`) → A leaves the strip, its shell keeps running invisibly; closing tab B never disposes it. Same for a removed-worktree fallback (GL-126) and Locate….
- Consequence: leaked shells/PTYs (and agent processes launched in them) for the rest of the session; stale `terminalViewByRepo` entries persist.
- Fix: Extract Method — one `dropRepoTab(path)` helper (lifetime end, unwatch, terminals, terminal view, tabInfo/recents prune) that closeRepo, publishSwitch's replaced source, repoMissing and locateMissingRepo all call.
- Confidence: high

### A7-2 — `toastWriteError` retry and index-lock recovery retarget the *currently open* repo
- Priority: P1 (misleading, will be got wrong)
- Smell: Race/staleness after await (Temporary Field: owner captured but not passed)
- Where: src/store/repoWriteActions/shared.ts:224-233; unguarded callers src/store/repoWriteActions/staging.ts:55,76,95,110,144,180,194,208; commits.ts:64,114; stashes.ts:59,75; remotes.ts:223. Guarded siblings: files.ts:107,174,203 (`if (ownerIsCurrent(get, owner))`). Recovery: src/store/ui/toasts.ts:52-62,78-103
- Evidence: `toastWriteError(get, error, retry)` passes `repoPath: get().summary?.path` read at *failure* time, and every retry closure is `() => get().stageFile(path)` / `get().commit(...)` / `get().pull()`, which re-read the live summary. Each action captured `owner` before its IPC but does not hand it over. Input: stage/commit/pull in repo A, switch to B while the IPC is in flight, A's write fails with `kind:"indexLock"` → toast offers "Remove lock & retry" bound to B: `removeIndexLockAndRetry` passes its `repoClosedDuringRecovery(B)` check, inspects/removes **B's** `.git/index.lock`, then re-runs the stage / commit (with the same message) / pull against B.
- Consequence: a recovery action removes another repo's lock and replays a write (including a commit) into the wrong repository.
- Fix: Introduce Parameter — `toastWriteError(owner, error, retry)` using `owner.path` for `repoPath`, and skip/degrade the retry when `!ownerIsCurrent`; the files.ts guard shape is already the right one.
- Confidence: high

### A8-1 — Escape from a worktree dialog raised off the branch navigator closes the navigator, not the dialog
- Priority: P0 (broken today; limited blast radius — wrong layer dismissed)
- Smell: Duplicate Code / sibling implementations that disagree (three hand-rolled "is an overlay blocking?" predicates)
- Where: src/components/chrome/action-bar/useActionBarModel.ts:105-115, src/components/chrome/action-bar/ActionBar.tsx:61, src/components/chrome/SettingsModal.tsx:54-64, src/components/chrome/repo-settings/RepoSettingsModal.tsx:46, src/components/chrome/overlays/menus/branch-context-menu/destructiveActions.tsx:91, src/components/chrome/overlays/menus/branch-context-menu/worktreeActions.tsx:36-61, src/components/chrome/overlays/dialogs/frame.tsx:105-110 (vs src/store/ui/dialogs.ts:222-231 `overlayOpenDialogs`)
- Evidence: `navOverlayBlocking` is `menu !== null || confirm !== null || prompt !== null || removeDetached !== null || createBranchOpen`. It omits `deleteWorktree`, `handoff`, `editCommitMessage`, `githubSignin`, `providerOauthSignin`, `aiActions`. Navigator rows raise BranchContextMenu; its "Delete ‹b› & worktree…" (destructiveActions.tsx:91) and Worktree ▸ "Check out here… / Hand off to…" (worktreeActions.tsx) call `openDeleteWorktree` / `openHandoff`, which set `menu: null` but leave `navOpen` true (store/ui/dialogs.ts:269,276). The navigator's `useDismiss` is therefore re-armed while the dialog is up. `useDismiss` listens for Escape on `document` in the **capture** phase and calls `stopPropagation()` (hooks/useDismiss.ts:27-39); `ModalFrame` listens on `window` in the **bubble** phase (frame.tsx:110). Input: navigator open → right-click a branch checked out in a linked worktree → Danger zone → Delete & worktree → press Escape. Outcome: the navigator behind the dialog closes and the DeleteWorktree/Handoff dialog stays; a second Escape is needed. (Any mousedown inside the dialog also collapses the navigator.) The comment at useActionBarModel.ts:98-104 describes exactly this failure for confirms — the list simply never grew with the dialogs. SettingsModal and RepoSettingsModal each hand-roll a different subset of the same predicate.
- Consequence: Wrong overlay dismissed today; every new dialog must be added to three ad-hoc lists (or re-break this), while `overlayOpenDialogs` already enumerates them.
- Fix: Replace Inline Code with Function Call — re-export `overlayOpenDialogs` from `store/ui.ts` (it is imported there but not re-exported, unlike `overlayOpen`) and derive all three from it, e.g. `navOverlayBlocking = state.menu !== null || overlayOpenDialogs(state) || state.createBranchOpen`, and `overlayBlocking` in the two settings windows from `overlayOpenDialogs(state)`.
- Confidence: high
