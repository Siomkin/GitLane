# AGENTS.md

Guidance for Codex (and any other coding agent) working in this repository.

> **This file is intentionally thin to avoid drift.** The canonical guidance lives in
> two files — read them before making changes; they are the source of truth:
>
> - **[`CLAUDE.md`](CLAUDE.md)** — what GitLane is, the build/verify commands, and the
>   full architecture (the Tauri IPC contract, the read/write split, the Rust gotchas,
>   the Zustand store layout, and the frontend structure).
> - **[`docs/rules/architecture-rules.md`](docs/rules/architecture-rules.md)** — the enforceable
>   checklist to follow when implementing new functionality (the cross-cutting IPC contract,
>   read/write split, definition of done, anti-patterns), with side-specific rules in
>   [`architecture-rules-rust.md`](docs/rules/architecture-rules-rust.md) and
>   [`architecture-rules-react.md`](docs/rules/architecture-rules-react.md) (the latter covers
>   SOLID / module decomposition).
>
> Everything that used to be duplicated here now lives in those files. Keep it that way:
> when guidance changes, edit `CLAUDE.md` / the `docs/rules/architecture-rules*.md` files, not this file.

## The non-negotiables (full detail in the files above)

- **Package manager is `bun`**, never npm/yarn. Verify a change with
  `bunx tsc --noEmit`, `(cd src-tauri && cargo check)`, and `bun run build`.
- **Rust core (`src-tauri/`) + React/TS frontend (`src/`), bridged by Tauri IPC.** An IPC
  change touches four layers in lockstep — see `docs/rules/architecture-rules.md` §1.
- **Reads use libgit2; writes shell out to real `git`; GitHub shells out to `gh`.** Don't
  reimplement writes with libgit2 — see `docs/rules/architecture-rules.md` §2.
- **Frontend tests run on vitest + Testing Library** (`bun run test`); the IPC boundary is
  mocked once in `src/test/invoke-mock.ts`. Coverage is partial, so the typechecks above are
  still the primary safety net.
