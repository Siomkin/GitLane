# Design

## Context

See `proposal.md` for motivation and scope. The changes live in the Rust backend (`src-tauri/`) across four existing subsystems:

1. **ACP unattended permission gate & catalogue** (`src-tauri/src/acp.rs`, `acp/session/permission.rs`, `acp/catalogue.rs`, `acp_agents.rs`)
2. **Git CLI write layer** (`src-tauri/src/git/write/remotes/transport.rs`)
3. **Worktree filesystem capability layer** (`src-tauri/src/git/worktree_fs/handle.rs`, `reads.rs`)
4. **Git transport credential resolution** (`src-tauri/src/git/transport_auth.rs`)

**Engine & boundary summary**:
- **Read vs. write engine**: Worktree reads remain libgit2 + `cap-std` (`worktree_fs`); git mutations remain real-`git` subprocesses (`git/write/`).
- **IPC contract**: No IPC commands, DTOs, or frontend wrappers change; all four IPC layers remain unchanged.
- **Zustand stores / frontend**: None touched, apart from one comment.
- **Dependencies / Tauri plugins**: None added (no `docs/tauri-plugin-decisions.md` changes).

## Goals / Non-Goals

**Goals:**
- Close the code-level findings the proposal lists with minimal, fail-closed guards that cover both the desktop binary and the headless `gitlane-agent` binary.
- Back every guard with focused unit tests covering both valid inputs and attack shapes.

**Non-Goals:**
- Rewriting ACP into an interactive permission UI.
- Changing release-CI macOS Developer ID signing (already specced in `platform/security`).
- Adding `--` to `git config` writes (no vector reproduced; see `proposal.md`).
- Touching the fingerprint, lease, or `.git/info/exclude` append paths of `worktree_fs`.
- Changing an adapter's session mode or sandbox so that it asks before reading. Decision 1 records that the shipped adapters do not ask today; Risks records why that is accepted.

## Decisions

### 1. Confine ACP `read` and `search` by value, not by key name
- **What the gate can see**: The client advertises `readTextFile: false`, so the adapter reads files itself. GitLane sees only the `toolCall` the adapter sends with `session/request_permission`. The gate therefore judges the adapter's report; it does not mediate the read.
- **Choice**: Shrink `AUTO_ALLOW_TOOL_KINDS` in `src-tauri/src/acp.rs` to `&["think"]` and give `"read"` and `"search"` their own arm in `permission_outcome`, calling a new `paths_stay_in_repo(call, cwd, kind)`.
- **Candidates**: every string value in `rawInput`, walked recursively through objects and arrays, plus every `locations[].path`. No key list. The workdir keys (`cwd`, `directory`, …) are ordinary candidates here, so a search of a subdirectory passes; `stays_in_cwd`'s equality rule stays an `execute`-only check.
- **Rule per candidate**, rejecting the call on the first failure:
  1. It begins with `~` → reject (adapters report resolved paths; GitLane does not expand a home directory).
  2. It has a `.git` component, case-insensitively → reject.
  3. Every other value is resolved against `cwd` through its nearest existing ancestor: that ancestor is canonicalised (following symbolic links) and the rest appended. Reject unless the result is inside `cwd.canonicalize()` and outside its `.git` (the repository root itself counts as inside). A `..` in the part that does not exist yet cannot be resolved, so it is rejected.
  4. A value that resolves inside the repository but names no existing file (a search term, a glob, a directory) is harmless. Resolving it rather than ignoring it is what catches a glob or missing child under an in-repo symlink (`dir-link/*`, `meta/*` where `meta -> .git`) and a Windows drive-relative value (`D:x`), which a code review found the first version let through.
  5. A value can embed a path in something longer (`cat /etc/passwd`, `rg key /Users/me/.aws`), so each whitespace-separated word is also judged by rules 1–3, and one escaping word rejects the call. A `file:` URI (`file:///etc/passwd`) is judged by the path after the scheme. A search term that contains an absolute-looking word (`TODO: fix /tmp hack`) is therefore refused; that is accepted.
- **What the adapters send (recorded 2026-11-22)**: the installed adapters ran one turn each in a throwaway repository: Claude via `claude-agent-acp@0.109.1`, Codex via `codex-acp@2.9.0`, and `cursor-agent acp`. Each turn read an in-repo file, searched for a term, and read a sibling file outside the repository. Kimi was not installed, and OpenCode refused for lack of credits.
  - **None of them sent `session/request_permission` for a `read` or a `search`**, including the read outside the repository. Claude's session opened in its `auto` mode. Codex and Cursor read without asking under their defaults.
  - Their `tool_call` reports show where a path would sit. Claude puts it in `rawInput.file_path` plus `locations`, though its first frame has an empty `rawInput` and `locations` until an update fills them. Codex puts it in `locations` only, with `rawInput: null`. Cursor puts it in `rawInput.path` plus `locations`. Codex's searches carry no input at all. Every read carried its path, so the per-value rule above needs no change.
  - **Consequence**: this gate covers only an adapter that asks. With the shipped adapters on their default modes, it does not stop a read outside the repository. The tests use the recorded shapes in place of permission payloads, since none were sent.
- **`read` fails closed**: at least one candidate must have named an existing file inside the repository. `search` needs none, because a search with no path runs in the session `cwd`.
- **Alternative considered**: a list of known path keys (`path`, `file_path`, `filePath`, …). Rejected: a path under any key not on the list would pass unchecked, and "`pattern` when path-like" cannot be tested.
- **Alternative considered**: rejecting all `read`/`search` calls. Rejected because Draft/Describe use them to inspect changed files.

### 2. Harden ACP `execute` shell-metacharacter and option denylist
- **Choice**:
  - Expand `has_shell_metachar` in `acp/session/permission.rs` to reject `'$'` (which subsumes `$(` as well as `$VAR` and `${VAR}`), and `text.chars().any(char::is_control)` (covering `\n`, `\r`, `\0`, and tab). zsh's `=(` process substitution is covered by the expansion scan below, which refuses an unquoted `(`.
  - Add `"--ext-diff"` to `DENIED_OPTIONS`.
- **What `--ext-diff` does and does not close**: `git log -p` and `git show` run a configured external diff program only with `--ext-diff`, so denying it closes those. Plain `git diff` honours `diff.external` by default and still does. That program comes from the user's own git config, which this gate already trusts, so it is not treated as a gap here.
- **Paths in arguments and option values**: `git diff` switches to `--no-index` by itself when a path argument lies outside the work tree, and options such as `blame -S<file>`, `--ignore-revs-file=<file>` and `diff -O<file>` read the file they name and echo its lines in errors. So every argument after the subcommand, every long option's value after `=`, and every tail of a single-dash token (`-pS/x` gives `-S` the value `/x`) is judged with the same rule as a reported `read` path (`paths::escapes_repo`): resolved against the session directory through its nearest existing ancestor, following symbolic links, it must stay inside the repository and outside `.git`. Revisions such as `HEAD~1`, `main..feature` and `HEAD:src/a.rs` resolve inside and pass, and so does an absolute path inside the repository. A pattern that looks like an outside path (`--grep=/api/`) is refused; that is accepted.
- **Shell expansion in string commands**: a string command is a shell line, and the shell can turn one token into several before git sees them: brace expansion (`{/dev/null,/etc/passwd}`, `--outpu{t,t}=`), globs (zsh's `*(e:cmd:)` runs a command; bash 3.2 matches `..` with `.?`), `~`, and zsh's `=cmd`. Before tokenizing, `has_shell_expansion` scans the line with quote awareness and refuses, outside quotes, `*` `?` `[` `]` `(` `)` `\` `!`, braces except a reflog suffix `@{…}` without `,` or `..`, a `#` comment, and a `~` or `=` that starts a word. Quoted text (`'*.rs'`, `--format='(%h) %s'`) stays allowed. `=(` no longer needs its own check.
- **Bare `git` only**: the program token must be exactly `git` or `git.exe`. A path (`./git`, `tools/git`) could run an executable the repository ships. On Windows, `cmd.exe` and `CreateProcess` also search the current directory before `PATH`, so a repository's `git.exe` can still win; that is not covered here. Windows shells' own expansion (`%VAR%`, PowerShell `(…)`) is not modelled either.
- **Alternative considered**: Rejecting all string-form `command` payloads and accepting only argv arrays. Rejected because some shipped ACP adapters still emit string-form `command` fields for `git diff --staged`.

### 3. Keep shipped `npx` ACP adapters on `@latest`; recognise them at any version
- **Choice**: The two `npx` entries in `acp/catalogue.rs` stay on `@agentclientprotocol/claude-agent-acp@latest` and `@agentclientprotocol/codex-acp@latest`. `current_command` keeps moving a saved row with no version onto the `@latest` entry on every load (`acp_agents.rs` `load_in`). A saved row naming any version is the user's choice and is kept.
- **Pins were tried and dropped**: an earlier version of this change pinned exact versions (`0.109.1` / `2.9.0`), with a `SHIPPED_PINS` list so saved rows followed each bump. The user decided against it: nobody would keep bumping the pins with release testing, so they would go stale and users would run outdated adapters. No release shipped the pins, so no saved row needs moving back.
- **Accepted risk**: `npx -y …@latest` runs whatever was last published under those package names, unattended, on every Draft/Describe launch. A compromised or broken adapter release would run on the user's machine the next time they draft a message. A user who wants a fixed version can set one on the agent's command in Settings; that row is kept.
- **`is_npx_adapter` and `install_for` match the package, not the exact string**: `launch_dir` (`acp/process.rs`) starts a catalogue `npx` adapter in the user's home so npm does not read the repository's `package.json` and `.npmrc`. With an exact-string match, a hand-pinned row would stop matching, start inside the repository, and lose its install hint on a failed launch. Both compare the command with its trailing `@<version>` removed (`split_version`; a scoped package's leading `@` is not a version separator) against each catalogue entry with its version removed.
- **Alternative considered**: Prompting the user on every `npx` launch. Rejected as excessive friction for normal Draft/Describe usage.

### 4. Guard the `git push` remote in `run_push`
- **Choice**: Call `ensure_operand(remote)?` at the top of `run_push` in `src-tauri/src/git/write/remotes/transport.rs`. `push_branch` takes its remote from `push_destination`, which reads `branch.<name>.pushRemote`, `remote.pushDefault` and `branch.<name>.remote` unguarded; the other callers (`publish_branch`, `push_tag`, `delete_remote_ref`, `force_push`) already guard theirs, and the central check makes that hold for future callers.
- **`run_push_under`**: the sibling entry point is called only from a test (`credential_bridge/tests/hook_boundary.rs`). Give it the same one-line guard so the two cannot drift.

### 5. Reject `.git` components where file content is opened for reading
- **Choice**: Add one shared `.git` component check, `has_git_component` in `worktree_fs`, which `path_guards.rs`, `write/files.rs` and the ACP gate also use. It matches case-insensitively and also matches the names NTFS resolves to `.git` (trailing dots or spaces, an `:stream` suffix, the `git~1` short name), the same names git refuses under `core.protectNTFS`. Call it once, in `open_worktree_file` (`handle.rs`); the other two `worktree_fs` functions that hand file content to a caller, `open_regular_worktree_file` (`handle.rs`) and `read_regular_worktree_file_bounded` (`reads.rs`), go through it. Every IPC content read goes through one of the three: `repo_file_text`, `read_binary_blob`, untracked-file diffs, conflicted-file reads.
- **Why not `open_parent_path`**: that function also serves the fingerprint helpers behind the discard, hard-reset and state leases, and `open_worktree_append_nofollow`. The fingerprint `probe` turns any error except `NotFound` into a hard failure, so a `.git` rejection there would fail a whole discard or reset if a `.git` path ever reached it. Those paths return no content over IPC, so guarding them buys nothing.
- **Write callers**: `write_repo_file` opens through `open_regular_worktree_file` after `normalize_relative`, which already rejects `.git`, so the new check changes nothing for it.

### 6. Enforce `validate_credential_authority` in `pick_server_gh`
- **Choice**: In `src-tauri/src/git/transport_auth.rs`, call `validate_credential_authority(remote_host).ok()?` and `validate_credential_authority(&account.host).ok()?` inside `pick_server_gh`, mirroring `credential_for_credential_host`. The validator is an allowlist (ASCII alphanumerics, `.`, `-`, an optional numeric port, or a bracketed IPv6 literal), so quotes, whitespace and shell metacharacters cannot pass.
- **No second validator in `gh_helper_config`**: `TransportCredential::Gh` is built in two places, both in `transport_auth.rs`, and after this change both validate. A hand-rolled character check in `credential_bridge.rs` would be a second rule set to keep in step. Update that function's doc comment to name both constructors instead.

### Size-Ceiling Plan
- `acp/session/permission.rs` (currently 204 lines) grows with the `read`/`search` check; if it passes ~320 lines, extract the path helpers into `acp/session/permission/paths.rs` to stay under the 400-line Rust ceiling.
- All other touched files receive small edits and stay within their existing bounds.

## Risks / Trade-offs

- **[Risk] A search term that looks like a path is rejected** (a pattern such as `/api/users`, or one containing `..`) → **Mitigation**: accepted. The call is rejected, not the turn; Draft/Describe mostly search for identifiers. Failing closed on an absolute-looking value is the point of the check.
- **[Risk] The gate trusts the adapter's report** → **Mitigation**: none available without mediating reads (`readTextFile: true`), which is out of scope. The requirement is worded as a rule on what is reported.
- **[Risk] The shipped adapters read without asking, so the gate never runs for them** (recorded under decision 1) → **Accepted**:
  - Reads inside the repository are what the user asked Draft/Describe to do.
  - A read outside the repository is governed by the adapter's own permission settings. Those are the user's configuration, which GitLane already trusts, like `diff.external` under decision 2.
  - Whatever such a read returns can reach only the draft message, which the user reviews before committing; GitLane sends it nowhere.
  - Not covered: an adapter whose own network tools could carry the content off the machine. That is likewise left to the adapter's settings.
  - The gate stays as defence in depth for any adapter that does ask.
- **[Risk] `@latest` runs the newest npm publish of each adapter unattended** → **Accepted** (design decision 3): pins would go stale without a bump process; a user can set a fixed version on the agent's command.
- **[Risk] Rejecting `$` and control characters could reject a legitimate command** (a `--format` or `--grep` value with a literal `$`, a tab in a string command) → **Mitigation**: accepted for unattended execution; such values are rare in the commands Draft/Describe run.
