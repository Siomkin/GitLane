---
name: split-module
description: Split an oversized file into a facade plus focused submodules without changing behaviour — for React feature folders (container / rows / hooks / pure model) and Rust modules (facade + `foo/` + `foo/tests/`). Use when a file is over the size ceiling (architecture-rules-react.md §4a, -rust.md §6), when `bun run sizes` fails, or when the user says a file is a "god component", asks to split/decompose/break up a file, or asks where a new piece of a growing feature should live.
---

# Split an oversized module

The deliverable is a **pure move**: same behaviour, same tests, new boundaries. A split that
quietly changes behaviour is worse than no split — it misleads review and QA.

## 1. Find the seam before touching anything

Read the whole file first. List its items (functions, components, constants) and group them by
**what would make each one change**. The groups are the submodules; if you cannot name them,
that is the finding — the module does more than its name admits, and naming it is the work.

Never chop at a line number. Never create `utils.ts` / `helpers.rs` / `misc.ts` as a home for
leftovers — a file named after where things didn't fit has no reason to change and will grow
back into the same problem.

Check for a sibling with the same shape before extracting: two hooks carrying the same engine
means the extraction is *shared*, and the split is worth more (`hooks/useDraftPersist.ts` came
out of two settings hooks that had copy-pasted the same 70 lines).

## 2. Target shapes

**React** (`docs/rules/architecture-rules-react.md` §2, §4a):

```text
features/<feature>/
  <Feature>.tsx          container — store selection, layout, dispatch
  rows/ | components/    presentational leaves, one per file
  use<Feature>*.ts       hooks — local state/effects
  <feature>Model.ts      pure utils (+ .test.ts) — no React
  index.ts               public surface
```

There is no `services/` layer: domain state and async orchestration belong in a Zustand store,
typed IPC in `lib/api/*`.

**Rust** (`docs/rules/architecture-rules-rust.md` §6): `foo.rs` keeps the module doc, shared
types and public entry points; `foo/` holds the focused submodules; a `mod tests` over ~150
lines becomes `foo/tests/{domain}.rs` with fixtures in `foo/tests/support.rs`. Visibility
pressure runs upward only — add `pub(super)` where the compiler demands it, never
pre-emptively. A test module is a descendant, so `pub(super)` on a submodule item is enough to
reach it from `foo/tests/`.

## 3. Move verbatim

Copy bodies unchanged — do not "improve while you're in there". Slicing exact line ranges with
a script beats retyping: it cannot silently reword a comment or drop a branch. Then fix only
imports, `mod`/`export` lines, and visibility.

If you *do* need a behaviour change, land it as a separate commit before or after, and say so
in the message.

## 4. Prove it was a pure move

Reviewing a large split by eye does not work. Diff the removed against the added lines with
whitespace normalised away, per line:

```bash
git add -A <paths>
git diff --cached -- <paths> | grep '^-' | grep -v '^---' | sed 's/^-//; s/[[:space:]]//g' | grep -v '^$' | sort > /tmp/del
git diff --cached -- <paths> | grep '^+' | grep -v '^+++' | sed 's/^+//; s/[[:space:]]//g' | grep -v '^$' | sort > /tmp/add
comm -23 /tmp/del /tmp/add     # removed lines that reappear NOWHERE
```

(Note `sed 's/[[:space:]]//g'`, not `tr -d '[:space:]'` — `tr` eats the newlines too and
collapses the whole diff onto one line, which makes the check silently pass.)

Every surviving line must be explainable in one sentence: a `use`/`import`, a `mod`/`export`,
a visibility keyword, a doc comment, or a formatter re-wrap of a body that changed indent
level. Anything else is real drift — investigate it before committing, and state the result in
the commit body so reviewers can trust the diff.

## 5. Gate

```bash
bunx tsc --noEmit && bun run lint && bun run test && bun run sizes
(cd src-tauri && cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test)
```

`cargo check` does **not** compile `#[cfg(test)]` code — use `--all-targets` or a moved test
module can stop resolving invisibly. Test counts before and after must match; say the number
in the commit body.

If the split shrank a file that is in `scripts/file-size-baseline.json`, run
`bun run sizes:update` so the ratchet tightens.

## 6. Commit

One split per commit, bodies verbatim, message explaining what each new module owns and why
the old file stopped being one thing. Reference the `GL` key when a ticket exists. Do not stack
independent splits on one branch — see the `gitlane-behavior-preserving-splits` memory.
