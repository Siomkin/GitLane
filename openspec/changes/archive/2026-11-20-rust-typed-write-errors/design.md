# Design

## Context

See proposal.md, Why. Engine: git CLI writes, with no change to which engine runs. There is no Zustand store, no TS API change and no IPC-layer change.

Today a write failure crosses IPC like this: `Err(String)` → `blocking` (`E: Into<CommandError>`) → `From<String> for CommandError` → `classify_failure`. GitLane-authored stale leases are built with `classify::stale(reason)`, which appends `STALE_SUFFIX`. Some are spelled out as `const` literals, and the classify tests pin every "again" literal under `write/` to `staleLease`.

## Goals / Non-Goals

**Goals:**
- A failure GitLane detects carries its kind from the point where it is created.
- The pilot modules use no string matching to decide control flow.
- Unmigrated modules keep compiling and behaving exactly as before.

**Non-Goals:**
- No new `CommandErrorKind`, no change to the message wording, and no change to `detail` or `hook` population.

## Decisions

### `WriteError` is a small enum, not a crate-wide catalogue

```rust
#[derive(Debug, thiserror::Error)]
pub(crate) enum WriteError {
    /// Exact-state lease failed; message already ends with STALE_SUFFIX.
    #[error("{0}")]
    StaleLease(String),
    /// Target path is already an openable repository.
    #[error("{0}")]
    AlreadyARepository(String),
    /// git's own (redacted) diagnostic, or a not-yet-typed GitLane message.
    #[error("{0}")]
    Git(String),
}
```

- **Visibility:** `pub`, because the pilot's public functions (`discard_file`, `init`, …) return it. Commands still use it only through `Into<CommandError>`.
- **Variants:** added only when a migrated producer needs one. Follow-up changes add variants such as `IndexLock` when they migrate `index_lock.rs`.
- **Rejected alternative:** a variant per `CommandErrorKind`. That would invite moving the git-output classification into producers, which this change does not do.
- **Constructor:** `WriteError::stale(reason)` replaces `classify::stale` in migrated code and keeps the same suffix. That keeps message text, and therefore the fallback classification, identical.

### Two-way `String` conversion during migration

- **`From<String> for WriteError` → `Git`:** a migrated fn can `?` helpers such as `index_lock::lock_index_writes` that still return `String`.
- **`From<WriteError> for String` → the `Display` text:** an unmigrated caller can `?` a migrated fn. The kind is lost in the type but not in the text, so `classify_failure` recovers it as it does today.
- **Rejected alternative:** migrating everything at once. That would be about 310 signatures in one diff, which is exactly the big chunk the user asked to avoid.

### `From<WriteError> for CommandError`

- `StaleLease(m)` → `CommandError::new(StaleLease, m)`.
- `AlreadyARepository(m)` → `CommandError::new(Git, m).with_code("alreadyARepository")`. This is the same kind and code the classifier produces today.
- `Git(m)` → `classify_failure(&m)`.
- **Placement:** the impl lives next to `WriteError` in `git/write/`, not in `git/types/error.rs`. Error types stay free of write-layer knowledge, as the `classify` module already is.

### Pilot scope

- **`discard_file/`** (about 600 lines, callers only in `commands/staging.rs`): `discard.rs` has the `ends_with(STALE_SUFFIX)` branch. `snapshot.rs` and `semantics.rs` produce the leases it matches.
- **`lifecycle/init.rs`** (138 lines, callers only in `commands/repo.rs`): two producers of the `alreadyARepository` text.
- **Excluded:** `index_lock.rs` (702 lines, already over the Rust size ceiling), so this change needs no split.

## Risks / Trade-offs

- **[Risk]** A migrated message changes by one character and the frontend gets a different kind. → Mitigation: tests assert the serialised `CommandError` (kind, code, message) for every pilot path, before and after.
- **[Risk]** `From<WriteError> for String` hides a typed error in an unmigrated caller. → Accepted for the migration window. The text keeps the classifier fallback correct, and the shim goes once the last module migrates.
- **[Trade-off]** For a while two ways of making a stale lease coexist (`classify::stale` and `WriteError::stale`). → `classify::stale` gets a doc line pointing new code at `WriteError::stale`.

## Migration Plan

Pilot first (this change). Then one follow-up change per module family (leases: worktrees, reset/head, `force_push`, `discard_all`, `squash_range`; then `index_lock` together with its split). Once no `write/` function returns `String`, a final change removes the two `String` conversions. Rollback is reverting the change, because the wire output does not change.
