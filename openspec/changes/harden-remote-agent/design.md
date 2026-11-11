# Design

## Context

See proposal.md for why. The facts that shape the approach:

- `remote/install.rs` builds two shell scripts that run on the server through `ssh … sh -c '…'`. The probe script runs on every connect. The install script runs only when the probe finds no agent for this app version.
- The install script does `mkdir -p` and then `chmod 700` on the binary only. With umask 002 the two directories come out `drwxrwxr-x` (reproduced locally), and a writable directory lets a group member rename a new file over a `700` one.
- `agent_binary` caches the unpacked binary at `<app data>/remote-agents/<version>/gitlane-agent-<target>` and returns it later without a check. The signature covers the `.gz`, so the unpacked file cannot be verified as it is.
- `ensure_installed` reads `GITLANE_AGENT_PATH` in every build profile.
- `forward::to_webview_event` builds the event's locator with `locator.with_path(path)`, which is plain concatenation onto `ssh://[user@]host[:port]`.

No git operation is added, so no read or write engine is chosen. No IPC layer changes: no command, handler, type or TS wrapper. No Zustand store is involved.

## Goals / Non-Goals

**Goals:**

- Meet the three requirements in `specs/remote/ssh-repos/spec.md`.
- Keep each fix inside the function that has the gap.

**Non-Goals:**

- Detecting an agent that the user's own account replaced (someone who already had the user's login). That needs a hash of the server's file compared with the signed binary on every connect: a hashing tool on the server, and a download on every desktop even when the server is current. A file planted by *another* account is caught by the ownership check in D1.
- Cleaning up the old cache file. It is never read again, and the cache has never been pruned.

## Decisions

### D1. Private and owned: `umask 077`, `chmod 700`, and an ownership test

Tightening permissions is not enough by itself. While the base directory was group-writable, a group member could have created the directory for a *future* version with their own `gitlane-agent` in it; after an app update the probe would find a "current" agent there and run it. Such a file or directory is owned by the account that made it, and a non-root account cannot create files owned by someone else. So the scripts also test ownership with `[ -O path ]` (true when the path exists and belongs to the effective user). `-O` is not in POSIX but works in dash and bash (checked here) and is documented for busybox `sh`.

- **Probe script** (runs on every connect):
  - `chmod 700 "$HOME/.gitlane-server" 2>/dev/null`, so an install made by an earlier version is tightened without a reinstall. The install script alone would not reach it, because it does not run when the agent is current. A failed `chmod` is ignored; the probe must still report the platform.
  - Run the agent's `--version` only when the base directory, the version directory and the agent file all pass `-O`. Otherwise the probe reports no agent, and the install script runs.
- **Install script:**
  - `umask 077` right after `set -e`: everything it creates is owner-only.
  - For the base directory and then the version directory: when it exists and fails `-O`, exit with the script's own error, which names the directory and says to remove it on the server; otherwise `mkdir -p` it and `chmod 700` it. The test comes before `mkdir`, because `mkdir` inside a base directory another account owns fails first, and ssh would report that as a sign-in problem.
  - Pruning is best effort (`rm -rf … || true`): an old directory another account planted cannot be removed, and that must not fail an install that already succeeded.
  - `rm -f` the partial file before writing it: a symlink left there by another account would otherwise redirect the upload.
  - An agent file owned by another account inside a directory the user owns needs no special case: the final `mv -f` replaces it.
- **`upload`:** today only "upload truncated" is recognised as the script's own failure; anything else with empty output goes to `ssh_errors::classify`. Give both script errors one shared prefix and treat that prefix as an agent-install error carrying the script's message.
- Only the base directory needs the `chmod` in the probe. Once it is `700`, nobody else can reach the version directories inside it.

*Alternative:* `chmod -R go-rwx` in the probe. Rejected: it walks every old version on each connect and adds nothing over a `700` base.

*Alternative:* delete a foreign-owned directory and reinstall. Rejected: the user cannot remove files inside a directory another account owns, and deleting on the user's behalf what someone else placed should be the user's decision.

### D2. Cache the signed form and verify it on every read

- Cache `gitlane-agent-<target>.gz` and `gitlane-agent-<target>.gz.sig` in the same per-version directory, each written through a partial file and a rename as today.
- One helper does "verify, then unpack" and both paths use it: the cache read and the fresh download.
- A cache read that fails for any reason (a file missing, a bad signature, a bad archive) counts as a miss: download, verify, and overwrite both files. Only a failed *download* verification is an integrity error.
- The old unpacked file is not read and not removed.

*Alternative:* keep the unpacked cache and store a hash beside it. Rejected: whoever can replace the binary can replace the hash. The signature is the only thing a local writer cannot forge.

Cost: one signature check and one unpack of a few megabytes, and only on a connect that installs.

### D3. The override is read in debug builds only

Gate the `GITLANE_AGENT_PATH` read in `ensure_installed` on `cfg!(debug_assertions)`. `agent_binary` keeps its `override_path` parameter, so the existing unit test and the SSH end-to-end test (both run under `cargo test`, a debug build) are unchanged. `bun run tauri dev` is a debug build, so the manual check in `docs/manual-verification-backlog.md` still works.

*Alternative:* a cargo feature. Rejected: it needs build configuration, and `debug_assertions` already separates development from release.

### D4. Drop a change notice whose path is not absolute

In `to_webview_event`, return `None` for a `repo-changed` path that does not start with `/`. With a leading `/` the path cannot extend the authority part of the locator, so the origin is always this host's.

*Alternative:* parse the joined locator and compare origins. Rejected: it gives the same result with more code.

### Size ceiling

`install.rs` is 329 lines, in the 251–400 look band. The change brings it to 380, still under 400, so no split. `install/tests.rs` would have passed 400, so the tests that run the two scripts under a local `sh` moved to `install/tests/scripts.rs` (unix only); the cache, signature and parsing tests stay in `tests.rs`.

## Risks / Trade-offs

- [An agent file the user's own account was made to replace keeps running] → Out of scope (see Non-Goals). A file or directory another account created, for this version or a future one, fails the ownership test.
- [`-O` follows links] → A symbolic link another account planted, pointing at something the user owns, would pass `-O`. The probe therefore also refuses a version directory or agent file that is a symbolic link, and the install script removes a linked version directory before creating a real one. A user's own link for the base directory (to a larger disk, say) still works. A hard link to one of the user's own executables inside a directory the user owns is not detected; running it needs that executable to do harm when called with `--version`. Accepted.
- [`-O` missing in some server's `sh`] → The scripts write the test as `! [ -O … ]`, so an unsupported `-O` reads as "not owned": the probe reports no agent and the install script stops with its ownership error instead of running anything. It fails closed. The script tests pass under dash as well as bash; task 4.2 checks a real host.
- [The foreign-owner case cannot be unit-tested without root] → Automated tests cover the owned path; the refused path is in the manual task.
- [First connect after the update downloads the agent again] → Once per target, same as a first install. Accepted.
- [`chmod` refused on an unusual home filesystem] → Ignored in the probe; the install script's `umask` still applies to new installs.

## Migration Plan

None to run. Existing installs are tightened on their next connect, and the cache refills on the next install. Rollback is reverting the change; the new cache files are then ignored.
