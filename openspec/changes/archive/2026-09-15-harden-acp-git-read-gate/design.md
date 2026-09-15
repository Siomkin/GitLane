## Context

See proposal.md — Why. `permission_outcome` (`src-tauri/src/acp/session/permission.rs`) delegates `execute` calls to `is_read_only_git`, which today:

1. rejects shell metacharacters (`; & | > < \` \n $(`),
2. `shell_words::split`s the line and requires program `git`,
3. loops over tokens: returns false on `-c`/`-C`/`--git-dir`/`--work-tree` (exact match), skips any other `-…` token, takes the first bare token as the subcommand and **breaks**,
4. checks the subcommand against `ALLOWED_EXECUTE_GIT` (`src-tauri/src/acp.rs`).

It reads only `rawInput.command` / `rawInput.args`; any other key on the tool call is ignored, including the working-directory field Gemini (`dir_path`) and Codex (`workdir`) send. `permission_outcome` takes `params` alone — `answer` (`acp/answer.rs`) and `run_session` (`acp/session.rs`, which owns `cwd`) do not pass the session path down.

Step 3 is where both leads live: the `=`-joined globals fall into the "skip any `-…`" branch, and the `break` means post-subcommand options are never read. GitLane does not spawn the command — the adapter does (`acp/process.rs`, cwd = repo) — so this gate is the only GitLane-side control.

Engine: none of libgit2 / git CLI / forge is involved; this is pure argv classification in Rust. No IPC layer changes. No Zustand store. `answer` and `permission_outcome` each gain one `&Path` parameter. `permission.rs` is ~120 lines, well under the size ceiling; the test file grows by two fixture arrays.

## Goals / Non-Goals

**Goals:**
- Deny-by-default for leading globals: an unknown `-…` before the subcommand rejects.
- Inspect options after the subcommand for the small set that writes a file or reads outside the repo.
- Refuse a structured working directory that is not the session's own.
- Keep the shipped happy paths (`git diff --staged`, `git --no-pager log -5`, `/usr/bin/git show HEAD`, argv form) approved.

**Non-Goals:**
- Modelling git's full option grammar. The post-subcommand check is a targeted denylist of known-dangerous options, not an allowlist of every diff/log option (that would break agents using ordinary `--format`, `--stat`, `-p`, pathspecs).
- Changing `ALLOWED_EXECUTE_GIT` membership or the non-`execute` kinds.

## Decisions

**D1 — Leading globals become an allowlist, not a longer denylist.**
Git has many globals that change where it reads (`--git-dir`, `--work-tree`, `--exec-path`, `--namespace`, `--super-prefix`, `-C`) or what it believes (`-c`, `--config-env`), and most accept both `--x <v>` and `--x=<v>`. Enumerating them is the mistake the current code made once already. Only `--no-pager` and `--no-optional-locks` are skipped; anything else starting with `-` before the subcommand returns false. *Alternative considered:* extend the denylist with `starts_with("--git-dir=")` etc. — rejected because the next unlisted global re-opens the hole.

**D2 — Post-subcommand scan is a targeted denylist.**
After the subcommand token, iterate the rest. Reject when a token `== "--output"`, `starts_with("--output=")`, `== "--no-index"`, `== "--contents"`, or `starts_with("--contents=")` (`git blame --contents <file>` annotates an arbitrary file — same class as `--no-index`). Match `--output` by exact/`=` so `--output-indicator-*` (harmless) still passes. *Alternative considered:* allowlisting post-subcommand options — rejected; agents legitimately pass arbitrary `--format`, `-n`, pathspecs, revisions, and `--` separators, and any allowlist would be either porous or constantly wrong.

**D3 — Keep the shape of the function; replace the `break`.**
Turn the loop into two phases (globals → subcommand → trailing options) inside the same function rather than introducing a parser type. Readers already know this function; the change stays reviewable as a small diff.

**D5 — A working-directory field must equal the session cwd.**
`permission_outcome(params, cwd: &Path)` checks `rawInput` for any of `cwd`, `workdir`, `dir_path`, `directory`, `working_directory`: a present, non-empty value that is not the session cwd (compared as `Path`s after trimming; relative values resolve against the cwd) rejects the call before the command text is inspected. An absent or equal value passes through to `is_read_only_git`. Codex always sends `workdir` equal to the session cwd, so its Draft path keeps working; Claude Code sends no such field. *Alternative considered:* reject any cwd-like key outright — rejected because it would break Codex unconditionally. *Alternative considered:* leave the field to the adapter and narrow the requirement to "in the directory the adapter runs it" — rejected; the `--git-dir` hardening is pointless if the same redirect is one JSON key away.

**D4 — Tests extend the existing table.**
Add the joined-global and option fixtures to `rejected`, and `--output-indicator-new=+` plus the existing globals to `allowed`, in `allows_only_read_only_git_for_execute_tools`. Add one end-to-end `session/request_permission` transcript case (like `rejects_an_execute_tool_whose_command_is_not_a_git_read`) for `git --git-dir=… log` to prove the reply is `reject-once`, and one for `git log` with `workdir: "/other"`.

## Risks / Trade-offs

- [An agent uses a legitimate global GitLane does not allowlist, e.g. `--literal-pathspecs`] → The command is rejected, not broken; the agent sees `reject_once` and can retry without the flag. Add to the allowlist on evidence, with a fixture.
- [A future diff-family option that writes files is not on the denylist] → The `ALLOWED_EXECUTE_GIT` doc comment now states the three-part contract (subcommand, globals, options), so adding a subcommand prompts a look at its option surface. Accepting this residual risk is deliberate; see D2.
- [An adapter spells the working-directory key differently] → Unknown keys are not inspected; add the spelling with a fixture when an adapter is seen to use it. The five names cover Gemini, Codex, and the common ACP examples.
- [Adapter passes argv (`command: [...]`/`args`) rather than a string] → Unchanged: both are joined and re-split today; the new checks run on the same token stream.

## Migration Plan

None. Behavioural narrowing only; no persisted state, no IPC contract change. Ship in a normal release.
