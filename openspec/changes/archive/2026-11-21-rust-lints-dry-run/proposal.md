# Proposal

## Why

`rust-review-findings` adopted four lints from BeautifulRust's `lints.toml` (`undocumented_unsafe_blocks`, `unwrap_used`, `allow_attributes_without_reason`, `unchecked_time_subtraction`) and deferred the rest. The remaining list is long: five rustc lints, the clippy `all` and `pedantic` groups, and about 25 individual clippy lints. Nobody has measured how many hits each would produce in `src-tauri`. Adopting them blind would either drown CI (clippy runs with `-D warnings`) or get them all switched off again. This change measures first, then adopts only what is cheap or catches real bugs.

There is no Jira issue. This change touches **Rust only** (`src-tauri/Cargo.toml` `[lints]` and the code a newly adopted lint flags). No IPC, frontend or behaviour change. Specs are skipped: it is tooling and a refactor with no behavioural requirement.

## What Changes

- **Measure.** For every candidate lint not yet adopted, count its hits in the desktop build (`--all-targets --all-features`) and the agent build (`--all-targets --no-default-features --features agent`). Record them in a table in `design.md`: lint, hits per build, the files with the most hits, and a sample.
- **Decide.** Mark each lint *adopt*, *skip* or *follow-up*, using the criteria in `design.md`. Write one line of reason per lint.
- **Adopt.** Add the *adopt* lints to `[lints.rust]` / `[lints.clippy]` in `src-tauri/Cargo.toml`, and fix or suppress every hit (`#[expect(…, reason = …)]`) so both builds stay clean under `-D warnings`.
- **Follow-ups.** List the *follow-up* lints (worth having, too many hits for one change) in `design.md`, each with its hit count, so it can become its own change.

Copy the adoption style from the existing `[lints.clippy]` block in `src-tauri/Cargo.toml`: one line per lint, with a comment saying where it came from.

## Risks

- None for secrets, auth or IPC: no command, credential path or wire type changes.
- A lint's suggested fix can change behaviour (for example `redundant_clone` or a cast rewrite). Every fix runs under the full test suite, and any fix that is not mechanically equivalent is called out in its task.
- Fixes may push files toward the size ceiling. `bun run sizes` is part of the checks.

## Non-goals

- Turning on the whole `pedantic` group. It is measured lint by lint, and only individual lints are adopted.
- The `[lib]`-only documentation lints (`missing_docs`, `missing_errors_doc`, `missing_panics_doc`) and `exhaustive_enums`: the crate is an application whose public items are not a published API. They are measured and recorded as *skip* with that reason.
- Fixing the hits of *follow-up* lints in this change.
- `unwrap_used`'s sibling `expect_used`, which BeautifulRust itself allows.
