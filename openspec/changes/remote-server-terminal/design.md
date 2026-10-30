# Design

## Context

See proposal.md for why. What shapes the approach:

- **The local terminal.** `terminal::spawn` opens a PTY, starts the login
  shell with `cwd` set to the repository, and streams output as `pty-data`. A
  writer thread per session keeps keystrokes in order. `pty_write`,
  `pty_resize` and `pty_kill` act only on a `session_id`.
- **Routing.** `invoke()` sends any call whose `path` or `worktreePath` is an
  `ssh://` locator to `remote_invoke`, which forwards remote-capable commands
  to the agent and rejects local-only ones. `pty_spawn` is local-only, so a
  remote tab's terminal is rejected today.
- **The desktop already runs `ssh` itself.** `remote_connect` and
  `test_ssh_connection` take a `locator` argument, which `invoke()` does not
  route, and run the user's `ssh` on this computer. `remote::connect::ssh_command`
  holds the fixed options (`-T`, keep-alives, the login shell's `PATH`). Outside
  a connect attempt it adds `BatchMode=yes`, because no one is there to answer.
  `connect_to` in `commands/remote.rs` turns a saved connection's key file into
  `-i … -o IdentitiesOnly=yes`.
- **Remote shells vary.** `remote::install::remote_sh` wraps a script in
  `sh -c '…'`, because the user's login shell may be fish or zsh. The install
  probe already relies on it.
- **The agent session is one `ssh` stdio pipe.** Frames go out through a single
  writer thread (`agent/serve.rs`), and requests run concurrently
  (`tokio::spawn`).
- **A disconnected tab has no summary** (`store/repoMissing.ts` wipes it), and
  the Terminal button is already disabled without one.
- **Two flows paste into the terminal and have no remote gate:** Commit with
  agent (`CommitSplitButton`, gated by `commitComposerModel`'s `agentsDisabled`)
  and the hand-to-agent dialog's Send (`HandToAgentBar` → `AgentMessageDialog`).
  Both call `sendToTerminal`. Today they fail on remote tabs only because no
  terminal can start.

## Goals / Non-Goals

**Goals:**

- Reuse the local terminal unchanged from the PTY outward. Only the program it
  starts differs.
- Leave the agent, its protocol and its build untouched.
- Keep every `ssh` question in the terminal. No new secret-bearing command.

**Non-Goals:**

- Sharing the agent session's authentication with terminals.
- Choosing a shell or environment for the user beyond what `ssh <host>` would
  give them.

## Decisions

### D1. `ssh -t` in the local PTY, not a PTY in the agent

The terminal is the user's `ssh` with a remote terminal, run in a local PTY.

- *Rejected: a PTY inside `gitlane-agent`.*
  - Terminal output would share the agent's one stdio pipe and single writer
    thread. A `cat` of a large log would hold up every git reply behind it
    unless the protocol gained flow control.
  - Requests run concurrently, so the spec's keystroke-order rule would need a
    dedicated ordered lane.
  - Bytes would travel base64-encoded in JSON lines.
  - Agent session ids would collide with local ones.
  - `portable-pty` would join the agent build, which `remote-ssh-repos` D2 kept
    desktop-only.
- *Rejected: `ControlMaster` sharing.* See `remote-ssh-repos` D4: Win32-OpenSSH
  lacks it, and its socket paths overflow macOS's limit.

### D2. A new local-only command that takes a `locator`

`pty_spawn_remote(locator, cols, rows)` returns the existing
`PtySpawnResponse`. Its sessions share `TerminalState`'s id counter, so
`pty_write`, `pty_resize` and `pty_kill` work unchanged. It joins the "Remote
plumbing" group of `LOCAL_ONLY` (`registration_tests/remote_split.rs`), next to
`remote_connect`.

Four IPC layers:

1. **Impl.** `remote/` builds the `ssh` argv: plain data, unit-tested, and
   independent of `portable-pty`. `terminal::spawn` takes the program,
   arguments and working directory to start instead of always building the
   login shell. The local path passes the login shell as before.
2. **Command and registration.** `pty_spawn_remote` goes in
   `commands/terminal.rs` (`async` + `blocking`, like `pty_spawn`), its handler
   line in `lib.rs`, and its `LOCAL_ONLY` entry. The command layer resolves the
   app data directory for the saved key file, as `connect_to` does. Nothing
   under `remote/` takes an `AppHandle` for this.
3. **Types.** None new.
4. **TS.** `api.ptySpawn` in `src/lib/api/terminal.ts` calls `pty_spawn_remote`
   with `{ locator: path, cols, rows }` when `isRemoteLocator(path)`. It
   validates the same response schema.

- *Rejected: an exemption for `pty_spawn` in `invoke()`'s routing.* The routing
  rule would become a list of exceptions.
- *Rejected: handling it inside `remote_invoke`.* That command forwards to the
  agent; desktop work does not belong in it.

### D3. The terminal's `ssh` command

```
ssh -t -e none [-i <key> -o IdentitiesOnly=yes]
    -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
    [-p <port>] [user@]host --
    sh -c 'cd <quoted server path> && exec "${SHELL:-/bin/sh}" -l'
```

- **Shared options.** The connect timeout and keep-alive options come from one
  list shared with `ssh_command`, so the two cannot drift. Both run `ssh` with
  the login shell's `PATH`. The hidden-console flag applies only to a non-PTY
  child, so the terminal has no use for it. The key file comes from one helper
  shared with `connect_to`.
- **Terminal-only options.** `-t` (stdin is already a PTY, so one is enough) and
  `-e none`. No `BatchMode`, no askpass environment, and
  `SSH_ASKPASS_REQUIRE` is removed from the inherited environment, so `ssh`
  asks on the terminal.
- **The remote command.** It is built with `remote_sh`, with the path quoted by
  `shell_words::quote`. `exec "$SHELL" -l` gives the user the same login shell
  `ssh <host>` would. If `cd` fails, `sh` prints the error and exits, so `ssh`
  exits and the terminal shows the existing exited state.
- **Locally.** The working directory is the home directory. `TERM` is
  `xterm-256color`, as for local terminals, and `ssh` passes it to the server
  in its terminal request.

### D4. Questions stay in the terminal

Password, passphrase, one-time-code and host-key questions are answered in the
terminal, where `ssh` expects them. Keyboard-interactive logins work without
special handling. The answer crosses IPC only as `pty_write` keystrokes, as a
`sudo` password in a local terminal does.

- *Rejected: an askpass lease per terminal, through the SSH prompt dialog.* It
  would add a second prompt surface for the same question. Reusing the
  connect-time password would also mean keeping a secret beyond the attempt it
  was typed for.

### D5. Gates

- **Lifted:** the Terminal button (`ActionBar.tsx`) and its shortcut
  (`useShortcuts.ts`). A disconnected tab keeps the button disabled through the
  existing no-summary condition.
- **Added, with the `REMOTE_UNAVAILABLE` tooltip and `useIsRemoteRepo`:**
  - `TerminalPanel.tsx` hides its agent buttons on remote tabs.
  - Commit with agent: `agentsDisabled` gains the remote condition.
  - Send in the hand-to-agent dialog (`AgentMessageDialog`). Its Copy stays,
    because copying the comments needs no terminal.

  These are AI-agent surfaces, which `remote/ssh-repos` already lists as
  unavailable. With a working terminal they would start a locally checked agent
  command on the server.
- **Stores:** no new store, and no change to `terminals.ts`. Tabs stay keyed by
  the repository locator.

### D6. Lifetime

- **Closing a tab** runs `pty_kill`, which ends the local `ssh`; the server
  closes the channel and hangs up the shell. Anything the user detached
  (`nohup`, `tmux`) survives, as with any `ssh`.
- **An agent session dropping** does not touch terminals.
- **A terminal's own connection dropping** ends that `ssh`, and the tab shows
  the existing exited state.

## Risks / Trade-offs

- [Password-only hosts ask again for each new terminal] → Accepted. It matches
  running `ssh` by hand, and key and agent users see no question.
- [Windows `ssh.exe -t` inside ConPTY, including resize] → Not verified here.
  Check on a Windows machine before the change is archived. If resize does not
  reach the server, record it as a known limit.
- [A server path containing quotes, spaces or `$`] → Quoted twice, by
  `shell_words::quote` and then `remote_sh`. A unit test covers a path with a
  space, a single quote and `$`.
- [`COLORTERM` does not reach the server unless the user's `SendEnv` /
  `AcceptEnv` allow it] → Accepted. Programs fall back to 256 colours.
- [File size] `terminal.rs` has about 290 production lines (look band). Taking
  the program as a parameter adds a few lines, so no split is due.
  `commands/terminal.rs` (236 lines) and `remote/connect.rs` stay well under
  the ceiling.
- [Dependencies] None new. `shell-words` is already used. No Tauri plugin,
  capability or CSP change (`docs/tauri-plugin-decisions.md` unaffected).

## Migration Plan

None. Rollback is restoring the two removed gates.
