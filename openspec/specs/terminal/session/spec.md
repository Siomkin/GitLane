## Purpose

GitLane hosts ACP agent sessions (Draft, Describe, conflict resolve) and answers the agent's permission requests without asking the user. This capability fixes what those unattended answers guarantee: only work that stays inside the open repository is approved on GitLane's say-so.

## Requirements

### Requirement: An unattended execute approval names a read of the open repository only

When an agent asks permission to run a shell command and GitLane answers without user involvement, GitLane MUST approve only a single `git` invocation that reads the repository the session was opened for. A command MUST be rejected when any of the following holds:

- it is not a `git` invocation, or the shell could chain, redirect, or substitute within it;
- a global option before the subcommand points git at another repository, work tree, object store, or exec path, or injects configuration — in either the separate-argument spelling (`-C <dir>`, `-c <key>=<value>`) or the joined spelling (`--git-dir=<dir>`, `--work-tree=<dir>`, `--config-env=<key>=<VAR>`);
- a global option before the subcommand is not one GitLane recognises as harmless (`--no-pager`, `--no-optional-locks`);
- the subcommand is not on GitLane's read-only list;
- an option after the subcommand makes git write a file or read outside the repository (`--output`, `--output=<file>`, `--no-index`, `--contents`, `--contents=<file>`);
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

### Requirement: Kind alone never approves an execute call

The tool-call `kind` an adapter labels a request with MUST NOT be sufficient to approve an `execute` call. Only the command text decides; kinds that cannot leave the repository (`read`, `fetch`, `search`, `think`) keep their kind-based approval.

#### Scenario: Execute labelled as a read
- **WHEN** the agent asks permission for a tool call whose kind is `execute` and whose command is `rm -rf .`
- **THEN** GitLane selects the reject option regardless of any other label on the request
