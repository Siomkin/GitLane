# Design

## Context

See proposal.md for why. Four BeautifulRust lints are already in `src-tauri/Cargo.toml`'s `[lints.clippy]`. CI runs clippy with `-D warnings` for both the desktop and the agent build, so an adopted `warn` lint fails CI on any hit. The toolchain is pinned at 1.100.0 (`rust-toolchain.toml`), and the crate is on edition 2024.

## Goals / Non-Goals

**Goals:**
- Every candidate lint has a measured hit count and a recorded decision.
- Every adopted lint leaves both builds at zero warnings.

**Non-Goals:**
- Lint policy for the frontend (oxlint), or for code outside `src-tauri`.

## Decisions

### Measuring

Run clippy once per build with every candidate passed on the command line as `-W <lint>` (for example `cargo clippy --all-targets --all-features --message-format=json -- -W clippy::pedantic -W unsafe_op_in_unsafe_fn …`). Count `compiler-message` entries by lint code, and dedupe by span so an item compiled into both the lib and the test target counts once. Do this without touching `Cargo.toml`, so the measurement leaves no trace. Record the per-lint counts for `pedantic` too, since the group is judged lint by lint.

Rejected: adding the lints to `Cargo.toml` and reading the CI output. That would make the measurement a code change and mix it with adoption.

### Adoption criteria

A lint is **adopted** when both hold:
- **Fixable now:** at most about 15 hits across both builds, each with a mechanical or clearly safe fix, or a narrow `#[expect(…, reason = …)]` where the flagged code is deliberate.
- **Worth having:** it catches a correctness or safety problem (`unsafe_op_in_unsafe_fn`, `multiple_unsafe_ops_per_block`, `cast_possible_truncation`, `cast_sign_loss`, `panic_in_result_fn`), or it guards a convention this repo already follows (`clone_on_ref_ptr`, `redundant_clone`, `dbg_macro`, `todo`, `wildcard_imports`, `fn_params_excessive_bools` after the mode-enum work).

A lint is **follow-up** when it is worth having but over the hit budget; it gets its own change.

A lint is **skip** when it is `[lib]`-oriented (documentation lints, `exhaustive_enums`, `print_stdout`/`print_stderr` in a binary that owns its output), purely stylistic with many hits, or already covered by an adopted lint.

### Suppressions

A deliberate hit gets `#[expect(lint, reason = "…")]` on the smallest item, never a crate-wide `allow`, the same rule the edition-2024 review applied to `collapsible_if`. `allow_attributes_without_reason` already enforces the `reason`.

## Risks / Trade-offs

- **Hit counts depend on the toolchain.** Recorded at 1.100.0; a toolchain bump can add hits to adopted lints. CI catches that at the bump.
- **`cast_*` fixes can change behaviour** when a cast was relied on to wrap. Each such fix uses `try_from` with explicit handling, or an `#[expect]` explaining why the value range is safe.
- **Over-budget correctness lints are deferred, not dropped.** If `cast_possible_truncation` measures at 80 hits, it goes to the follow-up list with its count.

## Measurements

### Candidates (task 1.1)

From BeautifulRust's `lints.toml`, minus what `src-tauri/Cargo.toml` already sets (`undocumented_unsafe_blocks`, `unwrap_used`, `allow_attributes_without_reason`) and what that file itself sets to `allow` (`expect_used`, `module_name_repetitions`, `must_use_candidate`, `module_inception`, `enum_glob_use`):

- **rustc (5):** `unsafe_op_in_unsafe_fn`, `missing_debug_implementations`, `missing_docs`, `unreachable_pub`, `rust_2018_idioms` (group).
- **clippy groups (2):** `clippy::all` (already on by default; measured to confirm zero), `clippy::pedantic` (each member that fires is listed in the table under its own name).
- **clippy lints (21):** `panic_in_result_fn`, `missing_panics_doc`, `missing_errors_doc`, `missing_assert_message`, `allow_attributes`, `multiple_unsafe_ops_per_block`, `fn_params_excessive_bools`, `struct_excessive_bools`, `clone_on_ref_ptr`, `redundant_clone`, `rc_buffer`, `exhaustive_enums`, `string_add`, `wildcard_imports`, `dbg_macro`, `todo`, `print_stdout`, `print_stderr`, `as_conversions`, `cast_possible_truncation`, `cast_sign_loss`.

### Results (task 1.3)

Measured at toolchain 1.100.0 on `latest`, one clippy pass per build with every candidate as `-W`, hits deduped by primary span. Desktop: `--all-targets --all-features`; agent: `--all-targets --no-default-features --features agent`. Every `pedantic` member that fired is listed under its own name.

| Lint | Desktop | Agent | Decision | Reason |
|---|---:|---:|---|---|
| `unreachable_pub` | 1156 | 902 | skip | 1156 hits; an application crate, `pub` vs `pub(crate)` churn with no behaviour gain |
| `doc_markdown` | 138 | 115 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `as_conversions` | 83 | 75 | follow-up | worth it, but 83 hits; its own change, together with the remaining cast lints |
| `map_unwrap_or` | 82 | 63 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `assert_is_empty` | 63 | 54 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `redundant_closure_for_method_calls` | 56 | 40 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `clone_on_ref_ptr` | 47 | 21 | follow-up | repo convention, but 47 hits; its own change |
| `needless_pass_by_value` | 41 | 20 | follow-up | 41 hits; perf-oriented, its own change if profiling asks |
| `similar_names` | 19 | 17 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `unreadable_literal` | 16 | 16 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `elided_lifetimes_in_paths` | 15 | 15 | adopt | adopted via `rust_2018_idioms`; mechanical `<'_>` |
| `redundant_clone` | 15 | 15 | adopt | clone whose original is never used again; mechanical removal |
| `too_many_lines` | 14 | 12 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `semicolon_if_nothing_returned` | 12 | 7 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `allow_attributes` | 11 | 11 | adopt | `#[allow]` → `#[expect]` so a stale suppression flags itself; cfg-dependent sites keep a reasoned `allow` under `expect(clippy::allow_attributes)` |
| `format_collect` | 10 | 10 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `manual_let_else` | 10 | 10 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `format_push_string` | 10 | 7 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `cast_possible_truncation` | 8 | 6 | adopt | silent truncation; `try_from` with handling, or `expect` with the range argument |
| `unnecessary_wraps` | 8 | 7 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `match_same_arms` | 8 | 6 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `single_match_else` | 8 | 8 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `items_after_statements` | 8 | 8 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `if_not_else` | 5 | 4 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `unnecessary_debug_formatting` | 5 | 5 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `needless_continue` | 5 | 5 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `panic_in_result_fn` | 4 | 4 | adopt | a fn returning `Result` should not also panic |
| `default_trait_access` | 4 | 0 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `case_sensitive_file_extension_comparisons` | 3 | 0 | adopt | `.PNG` vs `.png` is a real bug class |
| `unused_self` | 3 | 3 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `print_stderr` | 3 | 0 | skip | binary owns its output |
| `missing_docs` | 3 | 1 | skip | [lib]-only; the crate is not a published API |
| `struct_excessive_bools` | 3 | 3 | skip | 3 hits, all wire/DTO data, not modes |
| `uninlined_format_args` | 3 | 3 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `assigning_clones` | 3 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `cast_possible_wrap` | 2 | 1 | adopt | silent sign wrap; same treatment as truncation |
| `unnested_or_patterns` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `manual_assert` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `print_stdout` | 2 | 2 | skip | binary owns its output (`gitlane-agent --version`) |
| `large_stack_arrays` | 2 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `used_underscore_binding` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `struct_field_names` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `trivially_copy_pass_by_ref` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `cast_lossless` | 2 | 2 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `inconsistent_struct_constructor` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `cast_sign_loss` | 1 | 1 | adopt | silent sign loss; same treatment as truncation |
| `stable_sort_primitive` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `manual_assert_eq` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `duration_suboptimal_units` | 1 | 0 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `borrow_as_ptr` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `explicit_iter_loop` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `unnecessary_trailing_comma` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `ignored_unit_patterns` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `no_effect_underscore_binding` | 1 | 0 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `many_single_char_names` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `single_char_pattern` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `missing_assert_message` | 1 | 1 | adopt | one hit; assert says what went wrong |
| `missing_panics_doc` | 1 | 0 | skip | [lib]-only |
| `manual_is_variant_and` | 1 | 1 | skip | pedantic style lint; not a correctness or repo-convention guard |
| `unsafe_op_in_unsafe_fn` | 0 | 0 | adopt | each unsafe op in an unsafe fn needs its own block |
| `multiple_unsafe_ops_per_block` | 0 | 0 | adopt | one unsafe op per block, each with its SAFETY note |
| `fn_params_excessive_bools` | 0 | 0 | adopt | guards the mode-enum work |
| `wildcard_imports` | 0 | 0 | adopt | no glob imports (tests' `use super::*` is allowed) |
| `dbg_macro` | 0 | 0 | adopt | no leftover `dbg!` |
| `todo` | 0 | 0 | adopt | no `todo!()` in shipped code |
| `string_add` | 0 | 0 | adopt | build strings with `format!` / `push_str` |
| `rc_buffer` | 0 | 0 | adopt | `Rc<str>` over `Rc<String>` |
| `missing_debug_implementations` | 0 | 0 | skip | [lib]-oriented; nothing is exported |
| `missing_errors_doc` | 0 | 0 | skip | [lib]-only |
| `exhaustive_enums` | 0 | 0 | skip | [lib]-only |
| `clippy::all` | 0 | 0 | — | already on by default; zero extra hits |

### Follow-ups (task 2.3)

Worth having, over the hit budget; each becomes its own change. Counts are desktop / agent at 1.100.0.

- `as_conversions`: 83 / 75. Take it together with the cast lints adopted here, which already cover the lossy subset.
- `clone_on_ref_ptr`: 47 / 21. Write `Arc::clone(&x)` so a cheap pointer clone reads differently from a deep clone.
- `needless_pass_by_value`: 41 / 20. Mostly owned `String` / `PathBuf` parameters; only worth doing if profiling asks for it.
