# Proposal

## Why

Remote repositories (`remote-ssh-repos`, archived 2026-10-30) left the
integrated terminal disabled on remote tabs and named it a planned follow-up.
To run a build, a test or a git command GitLane has no button for, the user
still has to leave GitLane and `ssh` to the server by hand, then `cd` to the
repository again.

Jira: none known.

## What Changes

- The Terminal button and its shortcut work on a remote tab. A new terminal
  opens a login shell on the repository's server, in the open worktree's
  directory.
- GitLane starts the user's own `ssh` with a remote terminal (`ssh -t`) inside
  the existing local pseudo-terminal. The tab's port, user and saved key file
  apply, as they do for the tab's own connection.
- Questions `ssh` asks (password, passphrase, one-time code) appear in the
  terminal itself, as when the user runs `ssh`. GitLane does not answer, store
  or relay them.
- Each terminal is its own `ssh` connection, separate from the agent session.
  Terminal output never delays git commands, and a dropped agent session does
  not close an open terminal.
- If the repository's directory is gone on the server, the terminal shows the
  shell's error and ends.
- `ssh`'s escape character is turned off in these terminals (`-e none`), so a
  pasted line starting with `~.` cannot end the connection.
- The terminal-agent launch buttons stay hidden on remote tabs: their
  "installed" check looks at this computer's PATH, not the server's.

## Non-goals

- Running the shell inside `gitlane-agent`, or carrying terminal bytes over the
  agent session.
- SSH connection sharing (`ControlMaster`) to avoid a second login. Rejected in
  `remote-ssh-repos` (D4): Win32-OpenSSH lacks it, and its socket paths
  overflow macOS's limit.
- Answering the terminal's `ssh` questions through the SSH prompt dialog, or
  reusing a password typed while the tab connected.
- Terminal agents, the "open in terminal" paste queue (GL-177) and ACP agents
  on remote tabs. Each stays a separate follow-up.
- Keeping a shell alive across a dropped connection (reattach, tmux-style).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote/ssh-repos`: the integrated terminal leaves the list of features
  unavailable on remote repositories. A new requirement says a remote tab's
  terminal opens on the server, in the repository's directory, over the user's
  own `ssh`, and asks its questions in the terminal.
- `ipc/commands`: "Local-only commands reject a remote locator with
  unsupportedOnRemote" applies to the repository arguments (`path`,
  `worktreePath`). Local-only commands that take a `locator` and reach the host
  themselves (`remote_connect`, `test_ssh_connection`, and now the server
  terminal) are named as such. Its terminal example moves to another
  local-only command.

`terminal/session` is unchanged: its rule that a tab's shells end when the tab
leaves the strip covers these terminals as written.

## Impact

- **Processes:** Rust (a terminal `ssh` command and one new command), IPC (that
  command across the four layers), frontend (spawn routing, gates lifted, agent
  buttons hidden). No change to the agent, its protocol or its build.
- **Patterns to copy:**
  - `remote_connect` / `test_ssh_connection` in `commands/remote.rs`:
    local-only commands that take a `locator` argument, so `invoke()` does not
    route them to `remote_invoke`. They sit in `LOCAL_ONLY`'s "Remote plumbing"
    group in `registration_tests/remote_split.rs`.
  - `remote::connect::ssh_command` for the keep-alive options and the login
    shell's `PATH`; `connect_to` in `commands/remote.rs` for the saved key file
    (`-i … -o IdentitiesOnly=yes`).
  - `remote::install::remote_sh` for running a script under POSIX `sh` whatever
    the user's login shell is.
  - `terminal::spawn` and its writer thread, unchanged apart from the command it
    starts.
- **Frontend:** `api.ptySpawn` (`src/lib/api/terminal.ts`) is the one wrapper
  that branches on `isRemoteLocator`, because `invoke()` routes only `path` and
  `worktreePath`. Gates to lift: `ActionBar.tsx` (Terminal button) and
  `useShortcuts.ts` (toggle shortcut). `TerminalPanel.tsx` hides the agent
  buttons for remote tabs.
- **Secrets/auth risk:** no command gains a credential parameter; the
  secret-bearing set stays `answer_ssh_prompt`, `approve_https_credential` and
  `save_provider_token`. A password typed into the terminal reaches the local
  `ssh` as keystrokes through `pty_write`, as a `sudo` password in a local
  terminal does today; GitLane neither logs nor keeps it. Host-key checking stays
  the user's (no `StrictHostKeyChecking` override), and agent forwarding is never
  added. The server path is quoted for the remote shell. Nothing from the server
  reaches a local shell: `ssh` gets its arguments as argv.
- **Dependencies:** none new (`shell-words` is already a dependency). Assumed,
  to be verified on a real machine: Windows `ssh.exe -t` runs and resizes inside
  ConPTY.
