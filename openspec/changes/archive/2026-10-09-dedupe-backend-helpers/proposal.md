# Proposal

## Why

Several Rust helpers exist in two to seven copies. Some copies have already drifted
apart, which is exactly what `state_lease.rs` was created to prevent (GL-302):

- The discard-all and hard-reset lease parsers, index digests and budget loops are still
  line-for-line copies of each other.
- Commit-identity pinning is written five times.
- There are three process locks with two different poison policies. The stash lock is
  permanently broken after one panic.
- Origin list parsing is repeated five times, and two of the copies silently return `[]`.
- The CLI finishers, the remote-walk loop, the GraphQL argument builder and the
  percent-encoders are each repeated.

These come from the 2026-09-25 audit. No Jira issue exists yet.

## What Changes

- Extract the remaining shared lease primitives into `write/state_lease.rs`
  (`read_porcelain_z`, `index_digest`, `hash_scope_header`, `fingerprint_with_budget`).
  Callers keep their own filters and wording.
- One `commondir_lock` helper with the recovering poison policy, used by the index,
  identity **and stash** locks. After this, a panic no longer disables stashing until
  restart.
- One `identity::pinned_author_args` / `pinned_card_args`, which replaces five copies.
- Origin: one `parse_list<W, T>`, and remove `#[serde(default)]` from the two list DTOs
  that silently return empty. A changed Origin API shape then fails loudly, like its
  siblings do.
- Forge CLI plumbing: shared `finish_bytes` / `map_capture_error` in `bounded_output`,
  keeping one `Command::new` per CLI. Also `remote_urls()` + `project_for(kind)` in
  `resolution.rs`, and a single `prs::graphql_args`.
- A crate-level `percent` module replaces 4–6 encoder/decoder copies.
- Smaller items: handoff marker parsing, `repo_identity`, the app-config I/O shared by
  `acp_agents` and `terminal_agents`, `os_bytes`, stash-precedence lookup, preset
  migration by id, and byte-identical sibling pairs (`run_push_stable`,
  `apply_line_patch`, `same_path`, …).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

_None._ `skip_specs: true`. This is a pure refactor. The two behaviour-visible side effects
(the stash lock recovers after a panic, and malformed Origin lists fail instead of showing
empty) bring these units in line with their already-specified siblings. They add no new
requirement.

## Non-goals

- The forge **REST** transport dedupe (deferred backlog). Only the CLI side is touched.
- Changing lease semantics, the fingerprint encoding, or any message wording.
- Rename detection policy (A3-22). Unifying it is a performance trade-off on large
  commits. **Needs a decision**, and it is recorded in design.md without a task.

## Impact

- **Processes:** Rust only (`git/write/**`, `git/forge/**`, `git/oauth/pkce`,
  `redact.rs`, `acp_agents.rs`, `terminal_agents`, `git/worktree_fs`, `git/status`).
- **IPC:** none.
- **Secrets/auth:** the percent decoder is used by `redact.rs`, so keep its current
  `+` handling exactly (a `plus_as_space` flag). The redaction tests must pass unchanged.
- **Existing module to copy:** `state_lease.rs` (policy-neutral primitives) and
  `bounded_output/` (shared capture).
