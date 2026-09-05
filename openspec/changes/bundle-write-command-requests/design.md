## Context

Today `commands/commits.rs::commit(path, expected_branch, expected_oid, summary, description, amend, name, email, identity)` is mirrored by `commitsApi.commit(...)` passing the same positional list as a camelCase object literal to `invoke`; Tauri maps snake_case↔camelCase by name. Responses are validated with zod through `parse(schema, …)` (`src/lib/api/validate.ts`); requests are typed but not validated. `commands/registration_tests/argument_names.rs` checks naming conventions per argument. The write layer mirrors the sprawl (`commits/create.rs::{commit, commit_locked, commit_expected}`, `commits/squash.rs`, `squash_range.rs`, `patch_staging/apply.rs`, the `reset_to` owner). `clone_repo(url, dest, auth: TransportAuthRef)` and `stashPaths` already carry a struct across IPC, so the pattern exists.

## Goals / Non-Goals

**Goals:**
- Five commands with a self-describing request shape, validated on both sides, no `too_many_arguments` allows.
- Guard semantics unchanged; every existing test keeps passing with only its argument-shape assertions updated.

**Non-Goals:**
- A generic request envelope for all commands; changing read commands; codegen.

## Decisions

1. **Locator plus request** (`path: String, request: CommitRequest`) rather than one struct that includes `path`. Keeps `path` positional like every other command, so the registration tests' "first argument is the repository locator" convention and the `blocking(move || …)` open-repo shape stay uniform. Alternative: fold `path` into the struct — uniformity lost for no gain.
2. **Structs live in `git/types/requests.rs`** with `#[serde(rename_all = "camelCase", deny_unknown_fields)]` and `#[serde(default)]` on optional expectations, re-exported through the `types.rs` facade. The TS twin lives in `src/lib/api/git/types/requests.ts`; strict zod schemas in `src/lib/api/schemas/requests.ts`; the wrapper calls `parse(commitRequestSchema, request, "commit")` before `invoke`, the same helper used for responses, so the seam validates both directions for these five commands. `deny_unknown_fields` + `.strict()` turn a misspelled optional field into an immediate failure instead of a silently dropped expectation.
3. **Write layer takes the struct by reference**; `commit_locked` keeps its extra lock parameter; guard logic is untouched. Alternative: builder pattern — more code for five call sites.
4. **Two PRs**: (1) the commit/squash family (most tests, one composer), (2) `apply_line` + `reset_to`. Each PR lands all four IPC layers plus tests and an in-app exercise, per `architecture-rules.md`.
5. **Tauri argument naming**: the request arrives as `request` on both sides (no case mapping on the argument name); field mapping happens inside serde — the mapping CLAUDE.md wants "made explicit in api/*.ts" is now carried by the shared type.

## Risks / Trade-offs

- [Positional `null` becomes an absent field, changing what tests assert] → update the `invoke` argument assertions to object shape; behaviour is unchanged and the in-app exercise confirms it.
- [`argument_names.rs` conventions] → extend the allowlist with `request` as a recognised struct argument; keep the snake/camel check for the remaining positional arguments.
- [Zod `.strict()` on requests rejects extra fields a caller spreads in by accident] → intended; the error names the field.
- [Two commands under one lease (`commit_locked`) diverge from the struct] → the lock parameter stays separate; only the user-supplied fields move into the struct.

## Migration Plan

No persisted data and no external callers; each command switches atomically within its PR (Rust and TS in the same commit). Rollback is a revert of that PR.
