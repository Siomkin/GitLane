## Purpose

GitLane hosts ACP agent sessions (Draft, Describe, conflict resolve) and answers the agent's permission requests without asking the user. This capability fixes what those unattended answers guarantee: only work that stays inside the open repository is approved on GitLane's say-so.

## Requirements

### Requirement: An unattended execute approval names a read of the open repository only

When an agent asks permission to run a shell command and GitLane answers without user involvement, GitLane MUST approve only a single `git` invocation that reads the repository the session was opened for. A command MUST be rejected when any of the following holds:

- it is not a bare `git` invocation (a path such as `./git` could run an executable the repository ships), or the shell could chain, redirect, substitute, or expand within it — including any `$` (variable or command expansion), a backtick, an ASCII control character, and, outside quotes, glob characters (`*`, `?`, `[`, `]`), parentheses, a backslash, `!`, braces other than a reflog suffix such as `stash@{0}`, or a `~` or `=` that starts a word;
- a global option before the subcommand points git at another repository, work tree, object store, or exec path, or injects configuration — in either the separate-argument spelling (`-C <dir>`, `-c <key>=<value>`) or the joined spelling (`--git-dir=<dir>`, `--work-tree=<dir>`, `--config-env=<key>=<VAR>`);
- a global option before the subcommand is not one GitLane recognises as harmless (`--no-pager`, `--no-optional-locks`);
- the subcommand is not on GitLane's read-only list;
- an option after the subcommand makes git write a file, read outside the repository, or opt in to an external diff program (`--output`, `--output=<file>`, `--no-index`, `--contents`, `--contents=<file>`, `--ext-diff`);
- an argument or option value after the subcommand names a path outside the repository or inside its `.git` directory, after following symbolic links — including a path attached to an option (`blame -S<file>`, `--ignore-revs-file=<file>`) — because git reads that file (`git diff` even without `--no-index`);
- the tool call carries a working-directory field (`cwd`, `workdir`, `dir_path`, `directory`, `working_directory`) whose value is not the directory the session was opened for.

Rejection MUST select the agent's reject option; GitLane MUST NOT run, rewrite, or partially approve the command.

#### Scenario: Staged diff for a draft message
- **WHEN** the agent asks to execute `git diff --staged`
- **THEN** GitLane selects the one-time allow option without asking the user

#### Scenario: Log with a harmless global
- **WHEN** the agent asks to execute `git --no-pager log -5`
- **THEN** GitLane selects the one-time allow option

#### Scenario: Redirected repository in joined form
- **WHEN** the agent asks to execute `git --git-dir=/Users/x/other/.git log -p`
- **THEN** GitLane selects the reject option and the command is not approved

#### Scenario: Redirected work tree in joined form
- **WHEN** the agent asks to execute `git --work-tree=/tmp status`
- **THEN** GitLane selects the reject option

#### Scenario: Configuration injected from the environment
- **WHEN** the agent asks to execute `git --config-env=core.pager=SHELL log`
- **THEN** GitLane selects the reject option

#### Scenario: Unknown leading global
- **WHEN** the agent asks to execute `git --exec-path=/tmp/bin diff`
- **THEN** GitLane selects the reject option

#### Scenario: Diff written to a file
- **WHEN** the agent asks to execute `git diff --output=.git/config` or `git log -1 --format=x --output /tmp/out`
- **THEN** GitLane selects the reject option

#### Scenario: Diff of files outside the repository
- **WHEN** the agent asks to execute `git diff --no-index /dev/null /Users/x/.ssh/id_rsa`
- **THEN** GitLane selects the reject option

#### Scenario: Blame of an arbitrary file
- **WHEN** the agent asks to execute `git blame --contents /etc/passwd README.md`
- **THEN** GitLane selects the reject option

#### Scenario: Working directory pointed at another repository
- **WHEN** the agent asks to execute `git log -p` with a working-directory field of `/Users/x/other`
- **THEN** GitLane selects the reject option

#### Scenario: Working directory equal to the session's own
- **WHEN** the agent asks to execute `git diff --staged` with a working-directory field equal to the directory the session was opened for
- **THEN** GitLane selects the one-time allow option

#### Scenario: Option name that merely starts with output
- **WHEN** the agent asks to execute `git diff --output-indicator-new=+`
- **THEN** GitLane selects the one-time allow option, because the option does not write a file

#### Scenario: Diff of an outside file without --no-index
- **WHEN** the agent asks to execute `git diff /dev/null /etc/passwd` or `git diff /dev/null ~/.ssh/id_rsa`
- **THEN** GitLane selects the reject option

#### Scenario: Shell brace or glob expansion in a read-only git command
- **WHEN** the agent asks to execute `git diff {/dev/null,/etc/shells}` or `git status --short *(e:'touch x':)`
- **THEN** GitLane selects the reject option

#### Scenario: An option that reads the file it names
- **WHEN** the agent asks to execute `git blame -S/etc/passwd README.md` or `git blame -S.git/config README.md`
- **THEN** GitLane selects the reject option

#### Scenario: A git executable shipped in the repository
- **WHEN** the agent asks to execute `./git diff --staged`
- **THEN** GitLane selects the reject option

#### Scenario: Shell variable expansion in a read-only git command
- **WHEN** the agent asks to execute `git show $GITHUB_TOKEN` or `git rev-parse ${AWS_SECRET_ACCESS_KEY}`
- **THEN** GitLane selects the reject option

#### Scenario: Zsh process substitution in a read-only git command
- **WHEN** the agent asks to execute `git diff =(id)`
- **THEN** GitLane selects the reject option

#### Scenario: Carriage return inside a command
- **WHEN** the agent asks to execute a `git log` command whose text contains a carriage return
- **THEN** GitLane selects the reject option

#### Scenario: External diff opted in on a log
- **WHEN** the agent asks to execute `git log -p --ext-diff`
- **THEN** GitLane selects the reject option

### Requirement: Kind alone never approves an execute call

The tool-call `kind` an adapter labels a request with MUST NOT be sufficient to approve an `execute`, `read`, or `search` call. Only `think` MAY be approved on kind alone; every kind not named in this requirement (`fetch`, `edit`, `delete`, `move`, and any other) MUST be rejected.

A `read` or `search` call is decided by the paths it reports, not by its kind.

#### Scenario: Execute labelled as a read
- **WHEN** the agent asks permission for a tool call whose kind is `execute` and whose command is `rm -rf .`
- **THEN** GitLane selects the reject option regardless of any other label on the request

#### Scenario: Fetch is rejected
- **WHEN** the agent asks permission for a tool call whose kind is `fetch`
- **THEN** GitLane selects the reject option

### Requirement: An array-form execute command is validated as the argv that runs

When an agent's execute request carries its command as an argument array, the read-only
check SHALL validate those exact arguments. It SHALL never re-tokenise a joined string, so
the checked command and the executed command cannot differ.

#### Scenario: Quote characters that would merge arguments when re-split
- **WHEN** the request's argv is `["git","log","--format='","--output=/tmp/pwn","--grep='"]`
- **THEN** the request is not approved, because one argument is `--output=/tmp/pwn`

#### Scenario: Plain array form
- **WHEN** the request's argv is `["git","log","--oneline","-n","5"]`
- **THEN** it is approved exactly as the equivalent string command is

### Requirement: A repository tab's shells end when the tab leaves the strip

Whenever a repository tab is removed from the tab strip, for any reason, GitLane SHALL dispose of every terminal session that belongs to that tab. The reasons include closing the tab, an in-place worktree switch, falling back from a removed worktree, retiring a dead worktree, and Locate… re-keying a moved repository. No shell may keep running without a tab that shows it.

#### Scenario: In-place worktree switch
- **WHEN** a terminal is open in worktree A and the user switches the tab in place to worktree B
- **THEN** A's shell process is terminated and only B's terminals remain

#### Scenario: Removed worktree fallback
- **WHEN** the open worktree is removed externally and GitLane falls back to the main checkout
- **THEN** the removed worktree's shells are terminated

### Requirement: Typing into a terminal never blocks the interface and keeps its order

The pseudo-terminal write, which can block, SHALL NOT run on the UI thread and SHALL NOT run under the lock shared by all terminal sessions. Keystrokes SHALL reach the shell in the order they were typed.

#### Scenario: A child process stops reading input
- **WHEN** a program in one terminal stops reading stdin and the user keeps pasting input
- **THEN** the rest of the UI stays responsive, and other terminals can still be written to and killed

#### Scenario: Fast typing keeps its order
- **WHEN** the user types or pastes several chunks in quick succession
- **THEN** the shell receives the bytes in exactly the order they were typed

### Requirement: A Stop sent before the agent starts still ends the run

When the user stops an agent run (an AI action, or an AI conflict resolve) whose agent process has not started yet, GitLane MUST NOT start it afterwards. If the process started while the Stop was being handled, GitLane MUST end it right away. The run MUST end as stopped, not as an answer or a timeout.

#### Scenario: Stop while the run is still queued
- **GIVEN** the user started an AI action and its agent process has not been launched yet
- **WHEN** the user presses Stop
- **THEN** no agent process is launched for that run, and the run ends as stopped

#### Scenario: Stop lands while the process is being launched
- **GIVEN** an agent run whose process is being launched
- **WHEN** the user presses Stop before the launch completes
- **THEN** the process and every process it started end straight after the launch, and the run produces no answer

#### Scenario: Stop after the run finished
- **WHEN** the user presses Stop on a run that has already answered
- **THEN** nothing is stopped and no error is shown

### Requirement: Stopping a run never signals a process outside it

When GitLane ends an agent or helper process, by a Stop, a timeout, or the normal end of the run, it MUST signal only that process and the processes it started. It MUST NOT send any signal for a process it has already collected, so a process that later reuses the same id is never affected.

#### Scenario: Stop after the agent exited on its own
- **GIVEN** an agent run whose process has already exited and been collected
- **WHEN** the run is stopped, or the timeout fires
- **THEN** GitLane sends no signal to any process

#### Scenario: Agent left a child running
- **GIVEN** an agent process that started a child of its own and is still running
- **WHEN** the user stops the run
- **THEN** both the agent process and its child end, and no other process on the machine is signalled

### Requirement: An unattended read or search approval stays inside the open repository

When an agent asks permission for a `read` or `search` tool call and GitLane answers without user involvement, GitLane MUST approve it only when what the adapter reports about it stays inside the repository the session was opened for. GitLane MUST examine every string value in the call's raw input, at any depth, and every reported location path, whatever key it is stored under, and MUST reject the call when any of them:

- is an absolute path, or contains a `..` component, and does not resolve to a location inside the session repository;
- begins with `~`;
- contains a `.git` component, matched case-insensitively;
- resolves, through its nearest existing ancestor and after following symbolic links, to a location outside the session repository or inside its `.git` directory, whether or not the value itself names an existing path (a glob under an in-repository symbolic link resolves through that link).

GitLane MUST apply the same rules to each whitespace-separated word of a value, so a path embedded in a longer string is judged on its own, and to the path inside a `file:` URI.

A `read` call MUST additionally be rejected when none of the examined values names an existing file inside the session repository. A `search` call that names no path searches the session repository and MAY be approved.

This requirement governs only the permission requests an adapter sends. A read or search the adapter performs without asking is outside what GitLane can approve or reject here.

#### Scenario: Read targeting a file inside the open repository
- **WHEN** the agent asks permission for a `read` tool call targeting a regular file inside the session repository
- **THEN** GitLane selects the one-time allow option

#### Scenario: Search of a subdirectory of the open repository
- **WHEN** the agent asks permission for a `search` tool call whose raw input names a subdirectory of the session repository under a `directory` or `path` key
- **THEN** GitLane selects the one-time allow option

#### Scenario: Search of the repository root
- **WHEN** the agent asks permission for a `search` tool call whose raw input names the session repository's own directory as an absolute path
- **THEN** GitLane selects the one-time allow option

#### Scenario: Search that names no path
- **WHEN** the agent asks permission for a `search` tool call whose raw input holds only a search term such as `TODO`
- **THEN** GitLane selects the one-time allow option

#### Scenario: Read targeting a sensitive file outside the repository
- **WHEN** the agent asks permission for a `read` or `search` tool call targeting `~/.ssh/id_rsa`, `/etc/passwd`, or `../other/secret`
- **THEN** GitLane selects the reject option

#### Scenario: Outside path under an unfamiliar key
- **WHEN** the agent asks permission for a `read` tool call whose raw input holds `/etc/passwd` under a key GitLane has never seen, or nested inside an array or object
- **THEN** GitLane selects the reject option

#### Scenario: Symbolic link leaving the repository
- **WHEN** the agent asks permission for a `read` or `search` tool call targeting a path inside the session repository that is, or passes through, a symbolic link to a location outside it
- **THEN** GitLane selects the reject option

#### Scenario: Read targeting repository metadata
- **WHEN** the agent asks permission for a `read` or `search` tool call targeting `.git/config` or `.GIT/hooks/pre-commit`
- **THEN** GitLane selects the reject option

#### Scenario: Outside path embedded in a longer value
- **WHEN** the agent asks permission for a `search` tool call whose raw input holds `cat /etc/passwd` or `file:///etc/passwd`
- **THEN** GitLane selects the reject option

#### Scenario: Read with no verifiable path
- **WHEN** the agent asks permission for a `read` tool call whose raw input is missing, or names no existing file inside the session repository
- **THEN** GitLane selects the reject option

### Requirement: A catalogue npm-launched ACP adapter is recognised at any version

Loading saved agent settings MUST move a saved catalogue `npx` adapter command that names no version onto the catalogue's command, and MUST leave a saved command that names a version unchanged. A saved command for a catalogue `npx` package MUST be launched from outside the repository, and MUST get that package's install hint when its launch fails, whatever version it names.

#### Scenario: Saved adapter with no version moves to the catalogue command
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter with no version
- **THEN** the agent runs the catalogue's command

#### Scenario: Saved adapter on a version the user chose is kept
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter naming an explicit version
- **THEN** GitLane leaves the command unchanged

#### Scenario: Adapter on another version still starts outside the repository
- **WHEN** GitLane starts a saved catalogue `npx` adapter that names a version other than the catalogue's
- **THEN** the adapter process starts in the user's home directory, not in the repository

#### Scenario: Adapter on another version gets its install hint
- **WHEN** a saved catalogue `npx` adapter that names a version other than the catalogue's fails to launch
- **THEN** the error names that package's install command
