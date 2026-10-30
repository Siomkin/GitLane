# Design

## Context

See proposal.md for the motivation and scope. The current constraints:

- Every command addresses a repository by a local path string. 107 command
  parameters are named `path` and 5 are named `worktree_path`. Nearly every body
  is `blocking(move || git::…(&path, …))`.
- `git/` contains no Tauri code. `commands/registration_tests/tauri_free_core.rs`
  enforces that. But `tauri` is an unconditional dependency of `gitlane_lib`, and
  `commands::blocking` (`commands/mod.rs:47`) runs on
  `tauri::async_runtime::spawn_blocking`.
- The write layer is not pure CLI: 45 of its 109 files use `std::fs` and 23 use
  libgit2 directly (leases, path guards, index locks). Anything that serves a
  remote repository has to run that code on the server.
- The frontend reaches Rust only through `invoke()` (`src/lib/api/invoke.ts:115`).
  Response validation (`validate.ts`) runs after it, in the `api.*` wrappers.
- Only 7 command files take `AppHandle`/`State`: auth, diagnostics, github,
  terminal, repo (clone, watcher), and worktrees (events). These are where the
  local-only commands are.
- `watcher/classification.rs` (392 lines, already in the split band) mixes
  classification with emitting through `AppHandle` (`handle_event`, line 49).
  Its throttle decision (line 325) is already a pure function.
- The binary already has a second, re-entrant role: `lib.rs:40` checks
  `credential_bridge::is_askpass_invocation()` before starting Tauri.
  `minisign-verify` is already in `Cargo.lock` through the updater.

## Goals / Non-Goals

**Goals:**

- Run the existing git core unchanged on the server. Do not write a second read or
  write engine.
- Add no per-command forwarding code. Whether a command is served remotely is
  declared in one closed list.
- Use one `ssh` process per host, shared by every repository tab on that host.
- Keep the frontend change small: routing in `invoke()`, a locator helper, UI
  gating and a connection store.

**Non-Goals (design level):**

- Compression, multiplexing tuning or bandwidth limits beyond what the user's
  `ssh` config provides.
- Running more than one agent version per host at once beyond the
  install-directory layout (D7).

## Decisions

### D1. Agent, not git-over-ssh and not a mirror

The agent is the same Rust git core running headless on the server, driven over
the stdio of one `ssh` process.

- *Rejected: a local mirror plus running working-tree commands remotely.* This
  copies the code and history to the client, which the proposal rules out.
- *Rejected: git-only with no install* (`ssh host git -C … --porcelain`). This
  needs a second implementation of every libgit2 read, graph input included. It
  also leaves the 45 fs and 23 libgit2 write files without a remote equivalent.
  On top of that, every call costs a round trip, and Windows OpenSSH has no
  ControlMaster to amortise the handshake.

Engines are unchanged: libgit2 reads and git CLI writes, both executed on the
server. The forge stays local (D9).

### D2. One binary crate, gated by a Cargo feature

- `tauri`, its plugins and `tauri-build` become optional dependencies behind a
  default `desktop` feature.
- The new binary `src/bin/gitlane-agent.rs` has `required-features = ["agent"]`
  and is built with `--no-default-features --features agent`.
- Under `cfg(not(feature = "desktop"))`, `commands::blocking` uses
  `tokio::task::spawn_blocking`. Tauri's async runtime is already tokio, so its
  behaviour is identical.
- `keyring` (credential bridge, `secrets.rs`) and `portable-pty` are
  desktop-only.
- *Rejected: a workspace split into a `gitlane-core` crate.* It is cleaner
  long-term, but it moves every `git/` file and its `crate::` paths (`shell`,
  `redact`, `percent`, `log`). The feature gate gets the same build with far less
  churn, and the split can follow later if the gates spread.

### D3. Route in the frontend's `invoke()`, forward through one Rust command

- `invoke()` checks for a remote locator: an argument `path` or `worktreePath`
  whose value starts with `ssh://`. If there is one, it calls
  `remote_invoke({ command, args })` instead of the command itself.
- `remote_invoke` checks `command` against the agent's dispatch table. Anything
  else is rejected with `kind: "unsupportedOnRemote"`. It then rewrites locator
  arguments to the server path (it strips `ssh://<host>`), sends the request to
  that host's session, and returns the agent's JSON unchanged.
- Response validation still runs in the `api.*` wrappers, so agent responses get
  the same schema checks as local ones.
- *Rejected: wrapping Tauri's `invoke_handler` to intercept by name.* That
  depends on Tauri internals (the `Invoke` message and ACL resolution) and is
  harder to test.
- *Rejected: a remote branch in every command.* That touches 183 commands.

New IPC surface. All four layers apply to each command:

- **Commands:** `remote_invoke`, `remote_connect`, `remote_disconnect` and
  `list_ssh_hosts`, in `commands/remote.rs` and registered in `generate_handler!`.
- **Types:** `RemoteSessionState` and `RemoteProgress` in `git/types/remote.rs`,
  re-exported flat.
- **Event:** `remote-session-changed`, declared in `events.rs`.
- **TS:** `src/lib/api/remote.ts`.

### D4. The system `ssh`, with its questions asked in the app

- Spawn command: `ssh -T -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  -o ConnectTimeout=15 <host> -- <agent>`, with `SSH_ASKPASS` pointing at this
  binary and `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+), so every question
  `ssh` would ask on a terminal comes to GitLane instead. `BatchMode=yes` is gone:
  it disables askpass. (Revised after the first in-app run: keys-only and
  "connect once from a terminal" left most users unable to connect.)
- The askpass child is the GitLane binary re-entered before Tauri starts, like
  the git credential bridge. It sends ssh's prompt to the running app over a
  per-connection loopback listener; the child's environment carries the address
  and a 256-bit nonce, never argv. The app emits `ssh-prompt` (host, prompt text,
  kind: secret / confirm-host-key / plain), the frontend shows a dialog, and
  `answer_ssh_prompt` (the third secret-carrying command) returns the answer to
  that listener, which writes it to the child. Cancel answers with nothing, and
  ssh fails the connection.
- One attempt runs up to three `ssh` processes (probe, upload, session). The
  listener keeps the last secret answer in memory for the attempt and replays it
  when a *different* `ssh` (the helper's parent pid) asks the identical question,
  so a password is typed once. The same `ssh` asking again means the answer was
  wrong, so the user is asked again. The lease ends with the attempt and the
  answer goes with it. This avoids SSH connection sharing (`ControlMaster`),
  which Win32-OpenSSH lacks and whose socket paths overflow macOS's limit.
- Outside a connect attempt `ssh_command` keeps `BatchMode=yes`: there is no one
  to ask.
- Host keys: `StrictHostKeyChecking` keeps its default `ask`, so an unknown key
  reaches askpass as ssh's own "Are you sure you want to continue connecting"
  question with the fingerprint. Trusting answers `yes`, and **ssh** writes the
  user's known_hosts. A changed key still hard-fails in ssh, and GitLane offers
  no replacement.
- The 45 s hello watchdog pauses while a prompt is open; a person reading a
  fingerprint or typing a password is not a hung connection.
- The prompt dialog is mounted with the global overlays, so it shows during the
  launch restore too.
- GitLane never enables agent forwarding (`-A`).
- Windows: Win32-OpenSSH reads `SSH_ASKPASS` when `SSH_ASKPASS_REQUIRE=force`
  is set (reported in user threads, not documented); unverified until a Windows
  run.

### D5. Protocol: JSON lines over stdio

- **Handshake:** the agent's first line is
  `{"hello":{"version":"<app version>","protocol":1,"git":"<git version>"}}`.
- **Requests and responses:** a request is `{"id":n,"cmd":"…","args":{…}}`. The
  response is `{"id":n,"ok":…}` or `{"id":n,"err":<CommandError>}`.
- **Events:** the agent pushes `{"event":"repo-changed","payload":{…}}`. The
  desktop re-emits it through `crate::events::emit` with the path rewritten back
  into a locator.
- **Concurrency:** the agent serves requests concurrently and responses carry
  their request id. stdout carries only protocol frames; agent logs go to stderr,
  which the desktop redacts and appends to its own log.
- `CommandError` is built and redacted on the agent, where the failure is
  observed. The desktop redacts the error again before it crosses IPC, as
  defense in depth.
- *Rejected: binary framing or protobuf.* Command arguments and results are
  already serde camelCase JSON, so JSON lines need no second schema.
- **Frames larger than 64 KiB are compressed by the agent** (decided after S1).
  Over a real link, payload size dominates the time a call takes, and graph
  JSON compresses 3–8×. `ssh -C` stays the user's own choice.

**Spike S1 results (2026-10-29).** The release build of GitLane ran a stub agent
role that served `open_repo` and `commit_graph` as JSON lines. It was driven
directly over a pipe and over real ssh to a user-level `sshd` on 127.0.0.1.
Times are the median of 7 runs.

| Repository | Call | Agent ms | ssh round trip ms | Frame bytes | gzip bytes |
|---|---|---|---|---|---|
| fixture, 10k commits, merge-heavy | `open_repo` | 0.2 | 0.3 | 446 | 243 |
| same | `commit_graph(2000)` | 49 | 51 | 947,828 | 123,507 |
| same | `commit_graph(10000)` | 73 | 83 | 4,757,451 | 613,837 |
| GitLane, 836 commits | `commit_graph(2000)` | 19 | 22 | 1,418,402 | 454,589 |

- The agent's results over ssh were byte-identical to the direct pipe, so D3, D5
  and D6 hold as designed.
- Connecting with ssh, starting the agent and receiving its hello took 50 ms on
  loopback. A real link adds a few round trips for the handshake.
- On loopback, ssh added 0.1–10 ms per call. `ssh -C` added about 30 ms of CPU
  per megabyte, so it is not worth enabling for the user.
- Over a real link, bandwidth decides the time. The default 2,000-commit window
  is about 1–1.4 MB raw. That is roughly 0.4–0.6 s at 20 Mbit/s raw, and
  0.05–0.2 s compressed. A 10,000-commit page is 4.8 MB raw (about 1.9 s at
  20 Mbit/s) and 0.6 MB compressed (about 0.25 s). That gap is why frames above
  64 KiB are compressed.
- The graph costs 470–1,700 bytes per commit on the wire. The same JSON already
  crosses the local IPC, so this is not a new cost.
- Not measured: latency and bandwidth on a real WAN (this would need root to
  shape traffic), a Linux server, and concurrent requests.

### D6. The dispatch table is the "remote-capable" list

- The agent has one table, built with a small macro. Each entry names a function
  in `commands::*` and its parameters, and the agent deserializes the arguments
  into those parameters the way Tauri does (camelCase).
- The table calls the **same** command functions, so defaults such as
  `DEFAULT_GRAPH_LIMIT` never drift. Command functions in the table must take no
  `AppHandle`/`State`. They use `#[cfg_attr(feature = "desktop", tauri::command)]`
  so they compile in the agent build.
- **`LOCAL_ONLY`** is a closed, test-only list in
  `commands/registration_tests/remote_split.rs`, like `SYNC_BY_DESIGN` in
  `thread_placement.rs`. The desktop needs no runtime copy, because
  `remote_invoke` asks `agent::dispatch::is_remote_capable`. It covers terminal,
  ACP, auth, OAuth, keychain, credential approve/reject, github/forge commands,
  `set_remote_username` (account binding), clone, init, recents, identity
  defaults, signing keys, open-in-editor and reveal, file-workspace writes,
  diagnostics and the updater.
- **Enforcement:** a registration test fails if any command in
  `generate_handler!` is in both lists or in neither.
- **Progress commands (decided 2026-10-29: forward progress).**
  `move_branch_to_worktree` and `delete_branch_with_worktree` stream steps
  through `AppHandle` on the desktop, so their command fns cannot run headless.
  The agent calls the same `git::write::worktrees` function with a `Progress`
  sink. Each step becomes an event frame under the existing
  `handoff-progress` / `delete-worktree-progress` name, and the desktop re-emits
  it, so the checklist dialogs work unchanged on remote repositories.
- **Special case, watching:** `watch_repo` and `unwatch_repo` are handled on the
  desktop. For a remote locator they send `watch` and `unwatch` requests to the
  session instead of installing a local `notify` watcher.

### D7. Agent delivery: download, verify, then upload over the same connection

1. **Detect.** On connect, run `uname -sm` and `<dir>/gitlane-agent --version`
   in a short `ssh` exec, where `<dir>` is `~/.gitlane-server/<version>/`.
2. **Fetch locally if missing.** If the agent is missing or reports a different
   version, the desktop takes `gitlane-agent-<target>` for its own version from
   the GitHub release and caches it in app data. It verifies the download with
   `minisign-verify` against the updater public key already in `tauri.conf.json`.
3. **Upload.** Stream it into `<dir>/.gitlane-agent.partial` through
   `ssh host 'mkdir -p … && cat > …'`. Check the size, then `chmod +x` and rename
   atomically.
4. **Prune.** Keep the current and the previous version directories, and delete
   older ones.

**As built (`remote/install.rs`):**

- **Assets:** `gitlane-agent-<target>.gz` and `.gz.sig` under
  `releases/download/v<version>/`. Each `.sig` is a Tauri signer signature,
  checked with `minisign-verify` against `plugins.updater.pubkey` read from
  `tauri.conf.json` at compile time, the same way the updater checks itself.
  The verified, unpacked binary is cached under the app-data directory per
  version.
- **Remote scripts:** the probe and install scripts run through `sh -c`,
  because the user's login shell may be fish or zsh. The install script:
  - writes to a `.partial` file, checks the byte count, then `chmod 700` and an
    atomic `mv`;
  - runs the agent's `--version`;
  - prunes every version directory except the current one and the newest other
    one (by mtime), skipping any whose agent is running (`/proc/*/exe`).
- **Release CI:** `release-agent` builds each target natively in
  `rust:1.97.1-alpine` with the size profile `[profile.agent]`
  (`opt-level="z"`, LTO, strip). x86_64 builds on `ubuntu-24.04`, aarch64 on
  `ubuntu-24.04-arm`. `publish-release` waits for both.

Install progress uses the same progress-slot pattern as clone
(`write::lifecycle::CloneSlot`).

- *Rejected: bundling agents in every installer.* That adds two static binaries
  to every platform's installer for a feature most users won't use.
- *Rejected: having the server download the agent itself.* Servers are often
  offline or firewalled.
- **Dev builds:** setting `GITLANE_AGENT_PATH` uses a locally built agent and
  skips the download.
- **Release:** the release workflow gains `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl` agent builds, signed with the updater key and
  attached to the release.

### D8. Locator format and the frontend boundary

- **Format:** `ssh://[user@]host[:port]/absolute/path`. `host` may be an ssh
  config alias. `~` is not accepted. The open dialog resolves it by asking the
  agent for `$HOME` (part of the hello reply).
- **Keys:** the locator string is the repository key everywhere: tabs, recents,
  per-repo stores and persisted pins. Local paths keep working unchanged.
- **Paths in responses:** results that contain server paths, such as the
  repository root in `RepoSummary` and worktree paths, are turned back into
  locators in their `api.*` wrapper. That is the only place mapping happens, per
  the IPC rules. A helper `withLocator(locator, serverPath)` lives in
  `src/lib/paths.ts`.
- **Store:** a new leaf store, `src/store/remoteSessions.ts`, holds per-host
  connection state (connecting, installing with progress, connected,
  disconnected, failed). It sits below `repo.ts` in the import order. `repo.ts`
  reads it one-shot to choose the disconnected state for a tab.
- **UI gating:** one selector, `isRemoteLocator(path)`. It hides or disables the
  terminal button, the PRs tab, file editing, reveal and open-in-editor, and ACP
  actions for remote tabs.

**Frontend as built:**

- **Routing:** `invoke()` routes on `path`/`worktreePath`.
- **Paths back:** `openRepo` returns `path`, `workdir` and `mainPath` as
  locators, and so does `listWorktrees` for worktree paths.
- **Paths out:** worktree actions resolve a typed server path against the
  current repository's host.
- **Recents:** `recentsStatus` never probes a remote repository on the local
  disk. It reports the repository as present, and opening it is what reaches the
  host.
- **Session store:** `remoteSessions` is a leaf store, fed by
  `useRemoteSessionEvents` in `App`. It owns connecting and SSH-config hosts for
  the dialog.
- **Disconnected tabs:** a lost host is a `"disconnected"` kind of the GL-108
  missing-repo state. It offers Reconnect (`loadRepo`) and Remove, and leaves
  the recents entry openable. When the active tab's host drops, a quiet refresh
  either reconnects or lands in that state.
- **Gates:** one `useIsRemoteRepo` / `REMOTE_UNAVAILABLE` gates every
  local-only surface:
  - the PRs tab and Terminal button, and their shortcuts;
  - the file-edit predicate;
  - reveal and open-in-app items in the file menus;
  - the shared `AgentActionControl` and the AI menu item and shortcut.

  The other PR surfaces need no gate: `repo_forge` is local-only, so a remote
  repository has no forge.

### D9. What stays local, and how

- **Forge and PR features:** PRs are not served in this change. `repo_forge` is
  remote-capable (a read of the server's remote URLs), so the toolbar shows the
  provider and its link; PR loading is gated off on `isRemoteLocator`, not on
  the forge being absent.
- **Transport:** fetch, pull and push run on the agent's git with the server's
  helpers. The desktop strips GitLane's account refs, and so does the agent.
  For GitHub HTTPS remotes, the agent then supplies the **server's own** active
  `gh` account for that host (from `gh auth status --json hosts` on the server)
  as the auth ref, so the existing `TransportCredential::Gh` helper pins it for
  that git child. The token never leaves the server, and the server's git config
  is not changed. Without a `gh` login, git's own helpers apply as before. This
  is the `platform/git-invocation` delta.

### D10. Watcher on the agent

- The watcher takes an `OnChange` callback instead of an `AppHandle`, so the
  same module (roots, linked-worktree common dir, ignore filter, throttle) runs
  on the agent. The desktop's callback emits `repo-changed`. The agent's callback
  writes an event frame tagged with the `watch_repo` request's id, and the
  desktop re-emits it with the path rewritten back into a locator.
- If the watcher can't be installed (the server's
  `fs.inotify.max_user_watches` limit), the `watch_repo` request fails. The
  desktop shows that once as a non-blocking notice, and the tab falls back to
  the existing refresh on window focus and visibility (`useRepoWatcher.ts`).

### D11. Opening without ssh syntax

- The open dialog is two steps. First, a host picker: saved connections, then
  `~/.ssh/config` hosts (usable without saving), then "Add SSH connection…";
  connecting is where prompts, install progress and errors surface. Second, a
  folder browser rooted at the hello's `home`, with a typed absolute path still
  accepted. Closing it without opening a repository disconnects, unless a tab
  on that origin is open (the registry only closes on the last `unwatch_repo`).
- Saved connections (modelled on Claude's own SSH environments): name, host,
  optional user, port and key file. A Rust-owned `ssh-connections.json` in app
  data (`remote/connections.rs`), loaded into managed state at startup, keyed by
  origin (one connection per origin, derived through `Locator`). `connect_to`
  looks the origin up, so launch restore and reconnect use the same key as the
  dialog. Test passes the unsaved form's key to `remote_connect` explicitly,
  so cancelling after a test saves nothing.
- A key file is passed as `-i <path> -o IdentitiesOnly=yes`: with several agent
  keys loaded, ssh would otherwise offer those first and hit the server's
  authentication-attempt limit before the chosen key. `~/` is expanded in Rust,
  and a path that could read as an option is refused. It rides the per-origin
  connect context with the askpass environment, so probe, upload and session all
  use it.
- `list_directory(path)` is remote-capable: one level, names plus is-directory,
  is-repository (`.git` present) and readable flags, dot-entries hidden, an
  unreadable entry flagged rather than failing the call. It reads no file
  contents.

## Risks / Trade-offs

- [Feature gates leak into many files] → Gates are limited to dependency-level
  modules (commands that take `AppHandle`, terminal, secrets, the watcher
  install). CI builds the agent target, so a missed gate fails the build. If
  gates spread past roughly 15 files, switch to the workspace split (D2,
  alternative).
- [`git2` with vendored libgit2 may not build cleanly for musl] → Resolved by S2:
  both musl targets build and run, including on a real Ubuntu 26.04 server.
- [Agent binary size makes first connect slow on thin links] → S2 measured
  1.3–1.9 MB as a lower bound (0.9 MB gzipped). Upload happens once per version,
  with progress shown. Ship the agent compressed and use the `opt-level="z"` +
  LTO profile, which saved about 28%.
- [Frontend code that treats a repository key as a filesystem path breaks on
  `ssh://`] → Audit the users of `src/lib/paths.ts` and any code using
  `isAbsolute`, path joins or basename on repo keys. Cover it with tests that run
  the store flows with an `ssh://` locator.
- [A request in flight when the connection drops] → Every pending request
  rejects with `kind: "remoteUnavailable"` and the tab shows its reconnect state.
  Writes that may have half-completed on the server are re-read after reconnect.
  The existing leases (`staleLease`) already guard the destructive ones.
- [A malicious or compromised server] → The agent runs with the user's own
  authority on a machine they chose. The desktop treats agent output as
  untrusted: schema validation, redaction, size limits, and no execution of
  anything the agent returns. Secrets are never sent to it.
- [One stream means a large frame delays small ones (S1: a 10,000-commit graph is
  4.8 MB raw)] → Frames are compressed (D5). The graph keeps its 2,000-commit
  window. If status reads still stall behind graph pages on slow links, split
  large frames into chunks.
- [Server `git` older than 2.36] → The existing version gate runs on the agent
  and fails the connect with the usual typed error.
- [Two app versions connecting to one host] → Agents install per version
  directory, so each app gets its own agent. Pruning never deletes the running
  version's directory.

## Migration Plan

This is additive, so there is nothing to migrate. Ship on the beta channel first
with the "Open remote repository…" entry marked Beta. Rollback means hiding the
entry. Existing local repositories are untouched, because a path without
`ssh://` never reaches the remote code.

**Spikes, run before the main tasks:**

- **S1:** a loopback agent (`ssh localhost`) serving `open_repo` and
  `commit_graph` through `remote_invoke`, end to end. This proves D3, D5 and D6.
- **S2:** a musl cross-build of the agent, to measure binary size and confirm
  that `git2` (vendored) and `notify` build.

**Spike S2 results (2026-10-29).** The probe crate compiled GitLane's real,
unmodified `git/` tree, plus `shell`, `redact`, `percent` and `secrets`, without
Tauri. It used the same dependency versions and lockfile, built in
`rust:1.97.1-alpine` (the pinned toolchain).

- **Builds:** both `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`
  build with no extra system packages. That covers libgit2 1.9.7 (vendored by
  `git2`), `notify`, and the rest of the core's dependencies: `keyring` v1,
  `portable-pty`, `ureq` with rustls, `cap-std` and `rustix`. So excluding
  `keyring` from the agent (D2) is a least-privilege choice, not a build
  requirement.
- **Couplings:** `git/` needed one stub to compile headless:
  `events::SignInProgress` (`events.rs` imports `tauri::Emitter`), used only by
  the PTY-driven `git/forge/signin`, which task 2.2 gates as desktop-only. The
  probe also stubbed `log`, but that was unnecessary: `log.rs` is plain
  `eprintln!`. `crate::commands` is referenced only from tests.
- **Size (stripped):**

  | Target | Release | `opt-level="z"` + LTO | gzip -9 |
  |---|---|---|---|
  | x86_64 | 1.94 MB | 1.39 MB | 0.88 MB |
  | aarch64 | 1.85 MB | 1.33 MB | 0.87 MB |

  This is a lower bound: the probe calls only a few functions, so the linker
  drops the rest. With `-C link-dead-code` the upper bound is 17.7 MB, which
  keeps the unused parts of `ureq`, rustls, `keyring` and `portable-pty` that
  the agent will gate out. A full agent is expected at a few MB. That is a
  one-time upload per version.
- **Runs:**
  - On the real x86_64 server (Ubuntu 26.04, glibc 2.43, git 2.53), the binary is
    reported "statically linked" and needs no runtime libraries. It ran
    `open_repo` (1.7 ms) and `commit_graph(2000)` (78 ms). The login-shell PATH
    probe worked (21 entries), and the `notify` recursive watch (inotify)
    delivered an event.
  - The aarch64 binary ran the same smoke test in a bare `alpine:3.22` container.
- **S1 timings over a real network** (gigabit LAN to that server, 0.67 ms ping;
  median of 7 runs):
  - Connecting over ssh and receiving the agent's hello took about 0.45 s.
  - `open_repo`: 1.9 ms round trip, 1.3 ms of it agent work.
  - `commit_graph(2000)`: 78 ms, 69 ms agent, 0.95 MB.
  - `commit_graph(10000)`: 206 ms, 164 ms agent, 4.8 MB.
  - On a LAN the transport costs under 10 ms per megabyte, and `ssh -C` saved
    about 25%. The compression decision in D5 is for slower links.
- **Build environment:**
  - On Docker Desktop for macOS, rustc crashed with SIGBUS while the target
    directory was a bind mount. It built cleanly on a Docker volume. Use volume
    target directories for local container builds.
  - Emulated x86_64 builds take about 11 minutes on Apple Silicon, against 1
    minute for native arm64. Release CI should build each target natively (the
    self-hosted Linux runner for x86_64) or cross-compile, not emulate.

## Open Questions

- ~~Whether `list_ssh_hosts` should also follow `Include` directives.~~ Resolved:
  it reads `~/.ssh/config` with the `ssh2-config` crate (MIT), which follows
  `Include` and skips `Match` blocks, instead of a hand-rolled line scanner.
