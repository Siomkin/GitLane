## 1. Rules docs (GL-366)

- [x] 1.1 Update `docs/rules/architecture-rules.md`: name the registration guard in `commands/registration_tests/` and its residual arg-name-drift risk; list the IPC layer-4 files (`api/git/`, `github.ts`, `providers.ts`, `terminal.ts`, `updater.ts`, `schemas/`, `validate.ts`) and the `commands/updater.rs` placement; add "verify quoted paths resolve" to the §3 checklist; verify every path quoted in the file exists
- [x] 1.2 Update `docs/rules/architecture-rules-rust.md`: both sanctioned secret-receiving commands; `TransportCredential::{None, Gh, Glab, ProviderToken}`; `run_gh` plus the GL-106 PTY sign-in exception; internal typed errors (`HttpError`, `SecretError`, `LeaseError`, `CaptureError`) mapped to `CommandError` at the facades; verify with `grep -n` that each named symbol exists in `src-tauri/src`
- [x] 1.3 Update `docs/rules/architecture-rules-react.md` so the per-menu `menus/` split reads as done and the folder-module example points at `chrome/overlays/menus/`; verify the referenced files exist

## 2. CLAUDE.md and the plugin decisions record

- [x] 2.1 Correct CLAUDE.md: `chrome/overlays/menus/`, `lib/highlight/`, the OAuth client-id default location, watcher per tab in `hooks/useRepoWatcher.ts`, `src/app-shell/` with `ConflictWorkspace`/`HistoryInspectWorkspace`/`RepoFileWorkspace`, `features/repo-files/`, `lib/shortcuts.ts`, all stores (`notifications`, `commitAgentMessages`, `terminals`, `updates`, `acpAgents`, plus the `ui/` slices), IPC layer-4 files, platforms macOS/Windows/Linux; verify a shell loop resolving every backticked file path in CLAUDE.md reports no missing file
- [x] 2.2 Fix `docs/tauri-plugin-decisions.md` (`forge::context()`, remove `git/github/`); verify `grep -rn 'github::context' docs` is empty

## 3. OpenSpec config and roadmap

- [x] 3.1 Quote the colon-bearing entries under `rules.specs`, `rules.design`, and `rules.tasks` in `openspec/config.yaml`; verify `openspec status --change refresh-architecture-docs` prints no "Rules for … must be an array of strings" warning and `openspec instructions design --change refresh-architecture-docs --json` returns the rules
- [x] 3.2 Prepend a dated Status section to `docs/github-provider-auth-roadmap.md` (phases 1–3 done; phase 4 partially shipped as the `gh` preflight; native token and OAuth shipped for GitLab/Bitbucket under GL-132/GL-139; phases 5–8 undecided); verify the `docs.yml` workflow passes

## 4. Definition of done

- [x] 4.1 `openspec validate refresh-architecture-docs --strict` passes; a reviewer spot-checks five changed claims against the tree; `git diff --stat` shows only the seven files listed in the proposal's Impact section
