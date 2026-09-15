## Why

GitLane answers an ACP agent's `session/request_permission` unattended. For `execute` tool calls it approves the command when it looks like a read-only git command, so the shipped Draft/Describe instructions (`git diff --staged`) work without a prompt. The gate checks the subcommand name and a short denylist of global flags, but it misses the `--flag=value` spellings of the repository-redirecting globals (`--git-dir=…`, `--work-tree=…`), never sees `--config-env=…`, and never inspects options after the subcommand, and never looks at the structured working-directory field some adapters send with an `execute` call (Gemini's `dir_path`, Codex's `workdir`). Security audit run-2 traced two source-grounded leads (`acp/permission/is_read_only_git/global-flag-equals-form` and `acp/permission/is_read_only_git/subcommand-options-unchecked`): an agent could get `git --git-dir=/other/repo/.git log -p` (read another repository into the model context) or `git diff --output=.git/config` (a file write) approved as a "read" — and `{command: "git log -p", workdir: "/other/repo"}` sidesteps the global-flag check entirely, because the adapter honours that field when it spawns the command. Both are `needs_validation` because the run executed no code; the source path is unambiguous and the fix is small.

Jira: no issue exists yet (create a `GL-xx` Task before implementation and put the key in the branch name).

## What Changes

- The `execute` gate in the ACP permission answer switches leading global flags from a denylist to an allowlist: only known harmless globals (`--no-pager`, `--no-optional-locks`) are skipped; every other leading `-…` token — including `--git-dir=…`, `--work-tree=…`, `--config-env=…`, `--exec-path=…`, `--namespace=…`, and the separate-argument `-c`/`-C` forms — rejects the command.
- After the subcommand is found, the remaining tokens are scanned; a command is rejected when any token is a file-writing or outside-the-repo option of the diff family: `--output`, `--output=…`, `--no-index`, and `blame`'s `--contents`/`--contents=…` (which annotates an arbitrary file).
- A working-directory field on the tool call (`cwd`, `workdir`, `dir_path`, `directory`) rejects the command unless its value is the session's own cwd. The session cwd is threaded from `run_session` through `answer` into `permission_outcome`; the permission decision is otherwise unchanged.
- Regression fixtures for all three classes are added to the existing permission tests, in the same table-driven shape as `allows_only_read_only_git_for_execute_tools`.
- The doc comment on `ALLOWED_EXECUTE_GIT` says what "read-only" now guarantees (subcommand + globals + options), so a later addition to the list checks the option surface too.

No IPC command, type, or frontend change. Rust only (`src-tauri/src/acp/`).

The fifth run-1 lead (unsigned updater manifest version) is unrelated to the ACP gate and is not covered by this or the sibling changes.

## Capabilities

### New Capabilities
- `terminal/session`: what GitLane guarantees about the unattended permission answers it gives an ACP agent — which tool calls run without asking, and what an `execute` call must look like to be approved as a read of the open repository.

### Modified Capabilities
_None._ There is no existing spec for the ACP session; this change creates the `terminal/session` capability with the requirements this gate has always been meant to uphold.

## Non-goals

- No change to which git subcommands are read-only (`ALLOWED_EXECUTE_GIT` keeps the same members).
- No user-facing prompt for rejected commands; the reply stays `reject_once` and the agent turn continues as today.
- No sandboxing of the adapter process, no argv rewriting, no interception of what the adapter actually spawns — GitLane answers the question; the adapter runs the command.
- No changes to the `read`/`fetch`/`search` auto-allow kinds.

## Impact

- `src-tauri/src/acp/session/permission.rs` — `is_read_only_git` and `permission_outcome` (gains the session cwd).
- `src-tauri/src/acp/answer.rs`, `src-tauri/src/acp/session.rs` — thread `cwd` into `answer` / `permission_outcome`.
- `src-tauri/src/acp/session/tests/permission.rs` — new rejected/allowed fixtures.
- `src-tauri/src/acp.rs` — `ALLOWED_EXECUTE_GIT` doc comment.
- Secrets/auth/IPC risk: none introduced. The change narrows what an already-running agent process gets approved for; it touches no credential, no keychain path, and no IPC surface.
- Pattern to copy: the existing token loop in `is_read_only_git` and the table-driven `allowed`/`rejected` arrays in the test module.
