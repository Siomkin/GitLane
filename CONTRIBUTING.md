# Contributing to GitLane

Thanks for your interest in contributing! A few things to know before you open a PR.

## License

GitLane is licensed under **GPL-3.0-or-later** (see [LICENSE](LICENSE)). By
contributing, you agree that your contribution is licensed under the same GPL
terms. No Contributor License Agreement is required.

## Before you start

Read [`docs/rules/architecture-rules.md`](docs/rules/architecture-rules.md) — it's the
enforceable checklist that keeps changes consistent (the IPC contract, the read/write
split, and the definition of done).

## Development

See [README.md](README.md) and [CLAUDE.md](CLAUDE.md) for setup. In short:

```bash
bun install
bun run tauri dev      # launch the app
bunx tsc --noEmit      # typecheck the frontend
bun run test           # frontend tests (vitest)
(cd src-tauri && cargo check)   # verify the Rust backend
```

Please make sure typechecks and tests pass before opening a PR.
