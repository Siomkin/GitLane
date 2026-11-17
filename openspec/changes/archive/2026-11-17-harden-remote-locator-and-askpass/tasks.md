# Tasks

Note: the two failing regression tests from audit run-3 are already in the working tree, uncommitted (`src/lib/paths.remote.test.ts`, `src-tauri/src/remote/askpass/tests.rs`); tasks 1.1 and 3.2 build on them.

## 1. Locator: refuse non-absolute paths (frontend)

- [x] 1.1 In `src/lib/paths.ts`, make `withLocator` throw when `locator` is remote and `serverPath` is neither a same-origin locator nor a path starting with `/`; update the doc comment at lines 77-80 to say a different-origin locator is refused. Verify: the "never re-homes a locator…" case in `src/lib/paths.remote.test.ts` is changed to expect a throw for `@evil.example/srv/x`, `.evil.example/srv/x` and `:2222/srv/x`, and `bun run test src/lib/paths.remote.test.ts` passes.
- [x] 1.2 In `src/lib/paths.remote.test.ts`, replace the "never turns a server-supplied path into a locator for another host" expectation with one that `withLocator("ssh://devbox/srv/app", "ssh://evil/x")` throws, and keep the same-origin and local cases. Verify: `bun run test src/lib/paths.remote.test.ts` passes.
- [x] 1.3 Add `src/lib/api/git/repo.test.ts` and `src/lib/api/git/worktrees.test.ts` (mock `invoke` per `src/test/README.md`; for an `ssh://` path the mock answers `remote_invoke`, as in `OpenRemoteDialog.test.tsx:27`) showing that `openRepo` and `listWorktrees` reject when the server returns a path without a leading `/`, and resolve for `/srv/app`. Verify: `bun run test src/lib/api/git` passes.
- [x] 1.4 In `src/store/repoWriteActions/worktrees.ts`, compute `withLocator(summary.path, path)` before `api.moveBranchToWorktree` and before `api.addWorktree`, and use that value for `loadRepo`. Add store tests showing that on a remote tab a typed `wt/feature` rejects without calling the IPC, and that an absolute path still opens `ssh://devbox/<path>`. Verify: the new tests pass with `bun run test src/store`.

## 2. Server home directory (Rust)

- [x] 2.1 In `src-tauri/src/commands/remote.rs`, set `home` to `hello.home` filtered to values starting with `/` in both `remote_connect` (line 111) and `test_ssh_connection` (line 135). Add a unit test for the filter (a helper if needed) covering `/home/me`, `other.example/home/me` and `None`. Verify: `cd src-tauri && cargo test --lib remote::forward` passes, and the existing `OpenRemoteDialog.test.tsx` still passes (`bun run test src/components/chrome/overlays/dialogs/open-remote`). Done as `remote::forward::server_home` next to the event-path rule, because `commands/remote.rs` is 379 lines with no test module.

## 3. Askpass: replay only named prompts on OpenSSH 8.4+ (Rust)

- [x] 3.1 Create `src-tauri/src/remote/askpass/replay.rs` with `names_its_target`, `openssh_version` and `named_prompts_are_marked` per design.md §4, declared from `askpass.rs`. (`output_within` discards stderr, where `ssh -V` prints, so `named_prompts_are_marked` runs `ssh -V` on its own thread with a 5 s `recv_timeout`; `shell.rs` is unchanged.) Unit tests, inline in `replay.rs`: `names_its_target` is true for `me@devbox's password: `, `Enter passphrase for key '/home/me/.ssh/id_ed25519': ` and `(me@devbox) Password: `; false for `Password: `, `Verification code: `, `(no host) Password: ` and `me @devbox's password: `. `openssh_version` parses `OpenSSH_9.6p1, LibreSSL 3.3.6` → (9, 6) and `OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2` → (8, 1), and returns `None` for `plink: Release 0.81`. Verify: `cargo test --lib remote::askpass` passes.
- [x] 3.2 Thread a `replay_named: bool` from `askpass::start` (reading `named_prompts_are_marked()` once) through `serve` into `decide`, and require it plus `names_its_target` before replaying. Update the existing `decide` tests to pass the flag. Verify with `cargo test --lib remote::askpass`:
  - `a_prompt_naming_no_host_is_never_replayed_to_another_ssh` and `a_second_ssh_gets_the_answer_without_asking_again` (flag true) pass;
  - with the flag false, a second pid asking `me@devbox's password: ` is asked again;
  - with the flag true, `(me@jump) Password: ` then `(me@devbox) Password: ` from different pids asks twice;
  - with the flag true, after answering `me@jump's password: `, a different pid asking `(me@devbox) me@jump's password: ` is asked;
  - pid 0: a named prompt is replayed once with the flag true, and an unnamed prompt is not.
- [x] 3.3 Confirm `src-tauri/src/remote/askpass.rs` stays at or under 400 lines. Verify: `bun run sizes` passes (askpass.rs is exactly 400).

## 4. Definition of done

- [x] 4.1 Frontend checks pass: `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run cycles`, `bun run sizes`, and `bun run test:coverage && bun run coverage` (no file drops below its baseline).
- [x] 4.2 Rust checks pass in `src-tauri`: `cargo check`, `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`, `cargo test`, and `cargo test --no-default-features --features agent --lib`.
- [x] 4.3 Update user docs only if they describe being asked for the SSH password once per connect (search `docs/` and `docs-site/` for "password" near "ssh"); if they do, add that pre-8.4 ssh asks for each process. Otherwise note "no doc change" in this task. Verify: the search result is recorded here. Result: `docs-site/.../guides/remote-repositories.mdx:20-23` says answers go "to that connection only" with no once-per-connect promise (no change); `docs/manual-verification-backlog.md:121` said "asks once" and now notes the OpenSSH 8.4 condition.

## 5. Code review follow-ups

- [x] 5.1 `named_prompts_are_marked`: resolve the login-shell `PATH` before the 5 s timer, hide the console on Windows, and do not cache a timeout. Verify: `cargo test --lib remote::` passes.
- [x] 5.2 Accept user names that contain `@` by splitting at the last `@`. Verify: `alice@corp.example@devbox's password: ` and `(alice@corp.example@devbox) Password: ` count as named in `replay.rs` tests.
- [x] 5.3 Move `decide` into `askpass/replay.rs` and pass `replay_named` into `askpass::start`, so no test runs the machine's `ssh`. Add `the_listener_reuses_an_answer_only_when_started_for_a_marking_ssh`, which goes through the real listener with the flag on and off. Verify: `cargo test --lib remote::askpass` passes.
- [x] 5.4 Quote the refused path with `JSON.stringify` and cut it at 120 characters in `withLocator`'s error; restore `useRepo` state after `remoteWorktreePaths.test.ts`. Verify: `bun run test src/lib/paths src/store/repoWriteActions` passes.
- [x] 5.5 Record the ProxyCommand and hung-`ssh -V` limits in design.md Risks.
