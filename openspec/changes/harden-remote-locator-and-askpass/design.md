# Design

## Context

See proposal.md (Why). Both fixes are small and local, but they sit on security boundaries (server-supplied data, and a secret being reused), so the decisions are written down. A Fable review of the first draft (2026-11-17) found the pre-8.4 forgery, the typed-worktree caller and the Rust home path; this version folds those in.

- **Locator.** `withLocator(locator, serverPath)` in `src/lib/paths.ts` is the only place a path on the server becomes a locator. Callers: `src/lib/api/git/repo.ts` (`open_repo` summary `path`, `workdir`, `mainPath`), `src/lib/api/git/worktrees.ts` (`list_worktrees`), and `src/store/repoWriteActions/worktrees.ts:81,104`, where the path is typed by the user (`src/components/chrome/overlays/menus/prompts.ts:48`) and joined only after `api.moveBranchToWorktree` / `api.addWorktree` has already run. The folder browser joins `origin + dir` (`FolderBrowser.tsx:39`) from the agent's `home`, which `src-tauri/src/commands/remote.rs:111,135` copies into `RemoteHost.home` for both `remote_connect` and `test_ssh_connection`. The Rust side already refuses a non-absolute event path (`remote/forward.rs` `to_webview_event`).
- **Askpass.** `decide` in `src-tauri/src/remote/askpass.rs` remembers the last secret answer (prompt, answer, ssh pid) per connect attempt and replays it when a different ssh pid asks byte-identical text. Non-unix helpers report pid 0, which replays once. OpenSSH 8.4 and newer prefix a server's keyboard-interactive prompt with `(user@host) `; older versions pass the server's text through unmarked, so a server can reproduce ssh's own `user@host's password:` wording.

Engine: no git engine is involved. No IPC command, argument or type changes, so none of the four IPC layers moves. No Zustand store is added; `repoWriteActions/worktrees.ts` is an existing action slice of the repo store.

## Goals / Non-Goals

**Goals:**
- No server-reported or typed string can change the user, host or port of a locator.
- A remembered SSH answer is reused only when neither a server nor a second hop can have produced the matching text.

**Non-Goals:**
- Validating other fields of agent responses.
- Detecting non-OpenSSH clients (PuTTY/plink); they count as "version unknown" and ask every time.

## Decisions

### 1. `withLocator` throws on a non-absolute path

When `locator` is remote, `withLocator` returns `serverPath` unchanged only if it is already a locator with the same origin; otherwise it requires `serverPath` to start with `/` and throws an `Error` naming the refused value. A different-origin locator (`ssh://evil/x`) does not start with `/`, so it is refused. The doc comment at `src/lib/paths.ts:77-80` is updated to say so.

- *Alternative: return the input or drop the entry.* Rejected: a silently dropped worktree hides a misbehaving server, and returning the raw string re-opens the bug for callers that pass it on.
- *Alternative: validate in each caller.* Rejected: one guard at the only join point is the smaller change.
- Every async caller already catches: `repoLifecycleActions.ts:105,263`, `repoRefreshActions.ts:110,122`, `sideEffects.ts:110`, `shared.ts:346` (confirmed by the review).

### 2. Typed worktree paths are joined before the write

In `moveBranchToWorktree` and `createWorktreeAt` (`src/store/repoWriteActions/worktrees.ts`), compute `withLocator(summary.path, path)` first, before the IPC call, and use the result later for `loadRepo`. A relative path then fails before anything is created, and the throw never happens inside `guardDirtyFileView`'s confirm callback (`src/store/repoFilesActions.ts:247-251`), where nothing would catch it. Local tabs are unaffected: `withLocator` returns the path unchanged when `locator` is not remote.

### 3. `home` is filtered in Rust

`src-tauri/src/commands/remote.rs` sets `home` through `remote::forward::server_home`, which keeps it only when it starts with `/`, in both `remote_connect` and `test_ssh_connection`. The dialog's existing `reached.home ?? "/"` fallback then starts the browser at `/`. One filter at the source covers both commands and matches `forward.rs`.

### 4. Replay only named prompts, and only on OpenSSH 8.4+

New module `src-tauri/src/remote/askpass/replay.rs`, so `askpass.rs` (379 lines, in the 251–400 "look" band) stays under 400:

- `names_its_target(prompt) -> bool`, true when the prompt, with trailing whitespace trimmed, matches one of:
  - ends with `'s password:` and the text before it is a single `user@host` token;
  - starts with `Enter passphrase for key '` and ends with `':`;
  - starts with `(`, and the text up to the first `) ` is a `user@host` token.
  A `user@host` token has no whitespace and non-empty text on both sides of its last `@`, so a user name that itself contains `@` (`alice@corp.example@devbox`) still counts.
- `openssh_version(text) -> Option<(u32, u32)>` parses `OpenSSH_<major>.<minor>` (also `OpenSSH_for_Windows_<major>.<minor>`) from `ssh -V` output; anything else is `None`.
- `named_prompts_are_marked() -> bool` runs `ssh -V` with the same `PATH` as `connect::ssh_command` and the same hidden console on Windows (`crate::shell::hide_console`). The login-shell `PATH` is resolved before the 5-second timer starts, since its first lookup has its own bound. `ssh -V` prints to stderr, which `shell::output_within` discards, so it runs with `Command::output()` on its own thread and the caller waits with `recv_timeout`. A definite answer (a version, another client, or `ssh` failing to start) is cached in a `OnceLock` for the process; a timeout counts as `false` for that connect only and is checked again next time. True only for 8.4 or newer.
- `decide` (moved here from `askpass.rs`) replays only when the flag is true, the text is identical, and `names_its_target` holds.

The connect (`commands/remote.rs` `connect_to`) calls `named_prompts_are_marked()` and passes the result to `askpass::start(…, replay_named)`, which hands it to `serve`, `answer_one` and `decide`. Secret answers are still remembered as before, so the same-pid retry and pid-0 rules are unchanged. Tests pass the flag directly, so none of them runs the machine's `ssh`.

Why this blocks forgery: on 8.4 and newer, server text always arrives behind ssh's own `(user@host) `, so a server-written `me@jump's password: ` becomes `(me@devbox) me@jump's password: `, which differs from the remembered text; it still passes `names_its_target`, but naming `devbox` is harmless because a reply only goes to identical text.

- *Alternative: compare the host in the prompt with the locator's host.* Rejected: ssh prints the resolved `HostName`, not the config alias in the locator.
- *Alternative: stop replaying altogether.* Rejected: it breaks "one password for the whole connect" for everyone; the version gate limits that cost to old clients.
- *Alternative: keep replay on old ssh and document the risk.* Rejected by the owner (2026-11-17): asking every time is preferred.

## Risks / Trade-offs

- [Windows 10's bundled OpenSSH 8.1 and other pre-8.4 clients] → every `ssh` process of a connect asks again (several dialogs during an agent install). Safe, and fixed by upgrading ssh.
- [`user@host` does not name the port] → within one connect attempt on 8.4+, `me@localhost's password: ` for `localhost:22` and `localhost:2222` is the same text and would be replayed. Only reachable when one attempt spans two servers on the same name (a ProxyJump chain through the same host name); accepted and noted here.
- [One remembered slot] → password, then `Verification code:`, then the password again from a new ssh asks for the password twice. Existing behaviour; the spec says "asked once" only for a run of identical prompts.
- [A prefixed one-time code `(me@devbox) Verification code: ` matches the rule] → it is replayed to the next ssh once and fails, after which that ssh asks again. Existing behaviour, no cross-host leak.
- [ssh changes its wording or `-V` format] → the rule stops matching and fails safe: the user is asked again.
- [A worktree list from a misbehaving server fails as a whole] → acceptable; that server already returns paths pointing elsewhere.
- [A `ProxyCommand` that runs a different, older `ssh` binary] → the version check covers only the `ssh` on `PATH`. The proxy `ssh` inherits the askpass environment, so on 8.4+ a forged prompt from that hop could still be answered. Narrow, and accepted; ProxyJump uses the same binary and is covered.
- [A hung `ssh -V` (a wrapper that never exits)] → the connect goes on after 5 seconds, but the abandoned process and its thread live until the app exits. Letting `shell::timed` capture stderr would add kill-on-timeout and an output bound; left as follow-up.
- [File size] `decide` moved into `askpass/replay.rs`, so `askpass.rs` shrinks (370 lines) while the reuse rule and its unit tests live together.

## Migration Plan

None. No stored data or setting changes; rollback is reverting the change.
