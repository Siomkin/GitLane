# Tasks

## 1. Rust: the terminal's ssh command

- [x] 1.1 In `remote/connect.rs`, move the options shared by every `ssh`
  (the connect timeout and keep-alives) into one list that `ssh_command` and
  the terminal both use; verify
  `ssh_asks_through_the_app_only_during_a_connect_and_keeps_host_key_policy`
  passes unchanged.
- [x] 1.2 Move the saved-key lookup out of `connect_to` (`commands/remote.rs`)
  into one helper in `remote::connections` that returns
  `-i <key> -o IdentitiesOnly=yes` for an origin (or the form's override), and
  have `connect_to` use it; verify the existing remote command tests pass.
- [x] 1.3 Add the terminal argv builder in `remote/` (D3): `-t`, `-e none`, the
  key arguments, the shared options, the destination, `--`, then `remote_sh`
  around `cd <shell_words::quote(server path)> && exec "${SHELL:-/bin/sh}" -l`.
  Make `remote_sh` reachable from it. Verify with unit tests:
  - the argv holds `-t` and `-e none`;
  - it holds no `-T`, `BatchMode`, `StrictHostKeyChecking`, `-A` or
    `ForwardAgent`;
  - it carries the port, user and key arguments;
  - for a server path containing a space, a single quote and `$`, splitting
    the remote command back with `shell_words::split` (twice) yields the
    original path.
- [x] 1.4 Let `terminal::spawn` take the program, arguments and local working
  directory to start, with the local caller passing the login shell and the
  repository path as today. The remote spawn removes `SSH_ASKPASS_REQUIRE` from
  the child's environment. Verify the existing `terminal.rs` tests pass.

## 2. IPC: `pty_spawn_remote`

- [x] 2.1 Add `pty_spawn_remote(locator, cols, rows)` to `commands/terminal.rs`
  (`async` + `blocking`): parse the locator, resolve the key file from app data
  with the 1.2 helper, spawn the 1.3 argv with the home directory as the local
  working directory, and return `PtySpawnResponse`; verify `cargo check`
  passes.
- [x] 2.2 Register it in `lib.rs`'s `generate_handler!` and add it to the
  "Remote plumbing" group of `LOCAL_ONLY` in
  `registration_tests/remote_split.rs`; verify the registration tests pass.
- [x] 2.3 In `src/lib/api/terminal.ts`, make `api.ptySpawn` call
  `pty_spawn_remote` with `{ locator: path, cols, rows }` when
  `isRemoteLocator(path)`, validating the same response schema. Verify with a
  vitest using an inline-mocked `invoke`: a local path calls `pty_spawn`, and a
  locator calls `pty_spawn_remote` and never `remote_invoke`.

## 3. Frontend gates

- [x] 3.1 Drop the remote condition from the Terminal button in `ActionBar.tsx`
  and from `ShortcutId.ToggleTerminal` in `useShortcuts.ts`. Verify with tests
  that the button and shortcut work on a connected remote tab and stay disabled
  without a summary.
- [x] 3.2 Hide the agent launch buttons in `TerminalPanel.tsx` on remote tabs
  (`useIsRemoteRepo`); verify with a `TerminalPanel.test.tsx` case.
- [x] 3.3 Add the remote condition, with `REMOTE_UNAVAILABLE` as the title, to
  `commitComposerModel`'s `agentsDisabled` / `agentsDisabledTitle`, so Commit
  with agent is disabled on remote tabs; verify with a model test.
- [x] 3.4 Disable Send in the hand-to-agent dialog (`AgentMessageDialog`,
  opened from `HandToAgentBar`) on remote tabs, with the `REMOTE_UNAVAILABLE`
  tooltip. Copy stays, because copying the comments needs no terminal. Verify
  with a render test.

## 4. Docs

- [x] 4.1 In `docs-site/src/content/docs/guides/remote-repositories.mdx`, remove
  the terminal from "What isn't available on a remote repository" and add a
  short section on the server terminal. It should say that the terminal:
  - opens in the repository's directory;
  - uses its own `ssh` connection;
  - asks for a password in the terminal itself;
  - has no agent buttons.

  Verify that `bun run build` in `docs-site/` succeeds.
- [x] 4.2 In CLAUDE.md ("Remote repositories over SSH") and
  `docs/rules/architecture-rules.md` ("Classify it"), add that a local-only
  command that reaches a host itself takes `locator`, never `path` /
  `worktreePath`, so `invoke()` does not route it, and name `pty_spawn_remote`.
  Verify that the names match the code.

## 5. Verification

- [x] 5.1 Run the check suite: `bun check`, `bun run lint`, `bun run test`,
  `bun run build`, `bun run sizes`, `bun run cycles`, `cargo fmt --all --check`,
  and `cargo clippy` for the desktop build and for
  `--no-default-features --features agent`; all exit 0.
- [ ] 5.2 With `bun run tauri dev` against a real Linux server, confirm each of
  these:
  - with key auth, a terminal opens in the worktree's directory;
  - a password-only host asks in the terminal;
  - a removed directory shows the error and the terminal ends;
  - a pasted line starting with `~.` keeps the connection;
  - `cat` of a large file does not slow history browsing;
  - after closing the tab, `ps -u $USER` on the server shows no leftover shell;
  - after dropping the tab's agent connection, the terminal still works.

  Evidence so far (2026-10-30): the user reports that a remote terminal works in
  the dev build. Outside the app, the same `ssh` command against the Ubuntu test
  server:
  - opened bash in the requested directory;
  - reported a missing directory and ended;
  - passed a `~.` line to the shell.

  Still unchecked: the password prompt, heavy output, leftover shells after
  closing the tab, and an agent drop. Moved to
  `docs/manual-verification-backlog.md`, Sitting D.
- [ ] 5.3 On Windows, open a remote terminal and resize it, and check that
  `stty size` on the server follows. If it does not, record the limit under
  Risks in `design.md`. Moved to `docs/manual-verification-backlog.md`,
  Sitting D.
