# Tasks

## 1. Rust: private, owned agent directory (design D1)

- [x] 1.1 In `src-tauri/src/remote/install.rs` `install_script`, add `umask 077` on the line after `set -e`. Verify: a new test in `install/tests.rs`, built on `run_remote`, runs the script with `umask 002;` in front and asserts that `.gitlane-server` and its version directory have mode `700` and the binary `700`.
- [x] 1.2 In `install_script`, after `mkdir -p`: exit non-zero with a message that names the directory when `$base` or `$dir` fails `[ -O … ]`, then `chmod 700 "$base" "$dir"`, then `rm -f "$part"` before `cat > "$part"`. Verify: a new test pre-creates the version directory with mode `775` and a `.gitlane-agent.partial` symlink pointing at a file outside it; after the script runs, the directory is `700`, the agent is installed, and the outside file is unchanged.
  - Done with three deviations found in review, all recorded in design.md: the ownership test runs before `mkdir`, per directory; a version directory that is a symbolic link is removed first; and pruning is best effort. The script tests moved to `install/tests/scripts.rs` to stay under the size ceiling, with one added test for planted links.
- [x] 1.3 In `probe_script`, run `chmod 700 "$HOME/.gitlane-server" 2>/dev/null` before the mark is printed, and run the agent's `--version` only when the base directory, the version directory and the agent file all pass `[ -O … ]`. Verify: a new test creates `.gitlane-server` with mode `775`, runs the probe, and asserts mode `700`; the probe with no such directory still gives the platform line from `parse_probe`; and the last lines of `the_install_script_installs_checks_and_prunes` (probe after install is current) still pass.
- [x] 1.4 In `upload`, give the script's own errors ("upload truncated", "not owned") one shared prefix and return any stderr carrying it as an `AGENT_INSTALL` error with the script's message, instead of passing it to `ssh_errors::classify`. Verify: `a_truncated_upload_installs_nothing` passes with the prefixed message, and a new unit test of the stderr-to-error mapping covers the "not owned" text.
- [x] 1.5 Run `cargo test --lib remote::install`; every test in the module passes.

## 2. Rust: verify the kept agent on every use (design D2, D3)

- [x] 2.1 In `install.rs`, extract one helper that verifies packed bytes against a signature and unpacks them. Use it for the download in `agent_binary`. Verify: `a_tampered_download_is_refused_and_not_cached` passes.
- [x] 2.2 Change the cache in `agent_binary` to store `gitlane-agent-<target>.gz` and `gitlane-agent-<target>.gz.sig` (partial file, then rename, for each). A cache read goes through the helper from 2.1; any failure is a miss that downloads again and overwrites both files. Update `a_download_is_verified_unpacked_and_cached` for the new file names and assert the second call makes no fetch.
- [x] 2.3 Add a test: after a good download, overwrite the cached `.gz` with other bytes; the next `agent_binary` call fetches again and returns the signed binary, not the planted one. Add a second case with the `.sig` file removed.
- [x] 2.4 Add a test: an old unpacked `gitlane-agent-<target>` file in the cache directory is not returned; the call fetches and verifies.
- [x] 2.5 In `ensure_installed`, read `GITLANE_AGENT_PATH` only when `cfg!(debug_assertions)` is true. Update the doc comment on `agent_binary` to say "debug builds". Verify: `the_override_path_skips_download_and_verification` passes (it calls `agent_binary` directly, so the gate does not affect it), and the gate is the only place the variable is read: `grep -rn GITLANE_AGENT_PATH src-tauri/src` shows `ensure_installed` and the end-to-end test only.
- [x] 2.6 Update `CLAUDE.md` ("Remote repositories over SSH", the `install.rs` bullet) to say the agent directory is owner-only and the cached agent is re-verified on every install. Update the `GITLANE_AGENT_PATH` line in `docs/manual-verification-backlog.md` to say it works in debug builds only. Verify by reading both passages against the code.

## 3. Rust: change notices stay on their server (design D4)

- [x] 3.1 In `src-tauri/src/remote/forward.rs` `to_webview_event`, return `None` for a `repo-changed` payload whose `path` does not start with `/`. Verify: extend `events_come_back_as_locators_and_only_declared_names_pass` with paths `.other.example/x`, `:2222/x` and an empty string, each giving `None`, while `/srv/app` still maps to `ssh://devbox/srv/app`.

## 4. Integration checks

- [x] 4.1 Run `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`, `cargo test --lib remote::`, and `bun run sizes`. All pass.
- Result for 4.2 and 4.3 (2026-11-11, Ubuntu 26.04 x86_64 test box, `sh` is dash, login umask 0002): run through the opt-in `remote::e2e_tests` (real `ssh`, install, connect, read, watch) with an x86_64 agent built from this tree, not through the app window. No frontend file changed, so the window was not driven.
  - 4.2: the base and version directories were `775` before and `700` after; a fresh version directory created under umask 0002 came out `700`; the change made in a server shell arrived as a `repo-changed` event; an agent file owned by root was replaced by the user's own.
  - 4.3: with the version directory owned by root (set through a container, as `sudo` asks for a password there), the connect failed with `agentInstall` and "…/.gitlane-server/1.4.0 belongs to another account; remove it on the server", and no new agent process started. After the owner was restored the connect worked with no upload.
- [x] 4.2 With `bun run tauri dev` and `GITLANE_AGENT_PATH` set, open a repository on a test SSH host that already has `~/.gitlane-server`. Before connecting, run `chmod 775 ~/.gitlane-server` on the host. After the tab opens, `stat -c %a ~/.gitlane-server` on the host prints `700`, and a commit made in a server shell still appears in the graph without a refresh.
- [x] 4.3 On the same host, with root: `sudo chown root ~/.gitlane-server/<version>`, then disconnect and reconnect. Opening fails with an error that names the directory and says to remove it, and no `gitlane-agent` process started (`pgrep gitlane-agent` prints nothing). Restore the owner afterwards and confirm the repository opens again.
