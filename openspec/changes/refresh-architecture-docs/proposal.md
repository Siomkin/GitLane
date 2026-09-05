## Why

The rules docs, CLAUDE.md, and the OpenSpec config are the yardstick every contributor and agent session steers by, and they have drifted from the tree again. CLAUDE.md still points at `chrome/overlays/menus.tsx`, `lib/highlight.ts`, and `oauth-clients.json` (none exist), places the watcher debounce in `App.tsx` (it lives in `hooks/useRepoWatcher.ts`, one watcher per open tab), calls GitLane a client "for macOS" while releases ship Windows and Linux, and omits `src/app-shell/`, the `features/repo-files/` vertical, and five stores. `docs/tauri-plugin-decisions.md` still names `github::context()`; `docs/rules/architecture-rules-rust.md` still says one command may receive a secret and that `run_gh` is the only `gh` spawn. `openspec/config.yaml`'s `rules:` for `specs`, `design`, and `tasks` are silently dropped by the CLI — every `openspec` command prints "Rules for 'specs' must be an array of strings" — because entries contain unquoted `key: value` colons that YAML parses as maps, so only the proposal rules reach an agent. `docs/github-provider-auth-roadmap.md` (711 lines, phases 4–8 unchecked, last touched 2026-08-07) carries no status and predates the shipped provider-token and native-OAuth work (GL-132, GL-139).

Jira: GL-366 (Stale-pass the rules docs) — its audit list is the checklist; two of its items have since been fixed (the "no automated test suite" paragraph is gone and `bun run test` is in §3), the rest have not. Docs-only; no Rust, frontend, or IPC change, so this change sets `skip_specs: true`.

## What Changes

- Apply the remaining GL-366 items to `docs/rules/architecture-rules*.md`: name the registration guard (`commands/registration_tests/`) with its residual arg-name-drift risk; enumerate both sanctioned secret-receiving commands and the `Glab`/`ProviderToken` transport modes; record the GL-106 PTY sign-in as the `run_gh` exception; acknowledge the internal typed errors; rewrite the per-menu split example as done.
- Refresh CLAUDE.md paths and claims to the tree: `chrome/overlays/menus/`, `lib/highlight/`, the OAuth client-id default location, the watcher model, `src/app-shell/` and the `Conflict`/`HistoryInspect`/`RepoFile` workspaces, `features/repo-files/`, the shortcuts registry, the full store list, the IPC layer-4 file list (`providers.ts`, `updater.ts`, `schemas/`, `validate.ts`), supported platforms.
- Fix `docs/tauri-plugin-decisions.md` (`forge::context()`; no `git/github/` module).
- Quote the colon-bearing entries in `openspec/config.yaml` so all four rule sets load.
- Prepend a dated Status section to `docs/github-provider-auth-roadmap.md` recording which phases shipped, which were superseded by GL-132/GL-139, and that phases 5–8 remain undecided — no rewrite of the phases.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- None — `skip_specs: true`: documentation and planning-config accuracy only.

## Impact

- Docs: `CLAUDE.md`, `docs/rules/architecture-rules.md`, `docs/rules/architecture-rules-rust.md`, `docs/rules/architecture-rules-react.md`, `docs/tauri-plugin-decisions.md`, `docs/github-provider-auth-roadmap.md`, `openspec/config.yaml`.
- Secrets/auth/IPC risk: none — this documents the existing two-command secret rule (`approve_https_credential`, `save_provider_token`) and changes no code.
- Pattern to copy: GL-59's previous stale-pass — every rewritten claim checked against `git grep`, line references verified before editing.

## Non-goals

- Deciding native GitHub authentication (roadmap phases 5–8) or rewriting the roadmap.
- Changing any rule's substance (only its accuracy) or restructuring CLAUDE.md and the rules files.
- Building a doc-path linter (noted as a follow-up in design).
