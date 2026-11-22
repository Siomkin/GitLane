# Spec Delta

## MODIFIED Requirements

### Requirement: An unattended execute approval names a read of the open repository only

When an agent asks permission to run a shell command and GitLane answers without user involvement, GitLane MUST approve only a single `git` invocation that reads the repository the session was opened for. A command MUST be rejected when any of the following holds:

- it is not a `git` invocation, or the shell could chain, redirect, or substitute within it — including any `$` (variable or command expansion), a backtick, zsh `=(` process substitution, or an ASCII control character;
- a global option before the subcommand points git at another repository, work tree, object store, or exec path, or injects configuration — in either the separate-argument spelling (`-C <dir>`, `-c <key>=<value>`) or the joined spelling (`--git-dir=<dir>`, `--work-tree=<dir>`, `--config-env=<key>=<VAR>`);
- a global option before the subcommand is not one GitLane recognises as harmless (`--no-pager`, `--no-optional-locks`);
- the subcommand is not on GitLane's read-only list;
- an option after the subcommand makes git write a file, read outside the repository, or opt in to an external diff program (`--output`, `--output=<file>`, `--no-index`, `--contents`, `--contents=<file>`, `--ext-diff`);
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

## ADDED Requirements

### Requirement: An unattended read or search approval stays inside the open repository

When an agent asks permission for a `read` or `search` tool call and GitLane answers without user involvement, GitLane MUST approve it only when what the adapter reports about it stays inside the repository the session was opened for. GitLane MUST examine every string value in the call's raw input, at any depth, and every reported location path, whatever key it is stored under, and MUST reject the call when any of them:

- is an absolute path, or contains a `..` component, and does not resolve to a location inside the session repository;
- begins with `~`;
- contains a `.git` component, matched case-insensitively;
- names something that exists when resolved against the session repository and whose real location, after following symbolic links, is outside the session repository or inside its `.git` directory.

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

#### Scenario: Read with no verifiable path
- **WHEN** the agent asks permission for a `read` tool call whose raw input is missing, or names no existing file inside the session repository
- **THEN** GitLane selects the reject option

### Requirement: Shipped npm-launched ACP adapters pin explicit versions

Every shipped ACP catalogue adapter invoked via `npx` MUST name an exact package version rather than `@latest` or no version. Loading saved agent settings MUST move a saved catalogue adapter command that has no version, or that ends with `@latest`, onto the catalogue's pinned command, and MUST do the same for one that names a version an earlier GitLane release pinned. A saved command that names any other explicit version MUST be left unchanged. A saved command for a catalogue `npx` package MUST be launched from outside the repository whatever version it names.

#### Scenario: Fresh catalogue lists pinned npx adapters
- **WHEN** GitLane loads the shipped ACP adapter catalogue
- **THEN** every `npx`-launched adapter names an exact version and none ends with `@latest`

#### Scenario: Saved adapter on the latest tag moves to the pin
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter ending with `@latest`
- **THEN** the agent runs the catalogue's pinned command

#### Scenario: Saved adapter with no version moves to the pin
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter with no version
- **THEN** the agent runs the catalogue's pinned command

#### Scenario: Saved adapter on an earlier shipped pin moves to the current pin
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter naming a version an earlier GitLane release pinned
- **THEN** the agent runs the catalogue's current pinned command

#### Scenario: Saved adapter on a version GitLane never shipped is kept
- **WHEN** GitLane loads a saved ACP agent whose command is a catalogue `npx` adapter naming an explicit version that no GitLane release pinned
- **THEN** GitLane leaves the command unchanged

#### Scenario: Adapter on another version still starts outside the repository
- **WHEN** GitLane starts a saved catalogue `npx` adapter that names a version other than the catalogue's
- **THEN** the adapter process starts in the user's home directory, not in the repository
