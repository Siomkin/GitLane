## Context

Evidence gathered on 2026-09-05 with `grep -c` against the tree: `github::context` (1 hit in `docs/tauri-plugin-decisions.md`), "only command that may receive" (1 hit in `-rust.md`), `run_gh` "only place" (2 hits), CLAUDE.md's "desktop git client for macOS", its `App.tsx` ~400 ms debounce claim, and no mention of `src/app-shell` (which exists); CLAUDE.md backtick paths `chrome/overlays/menus.tsx`, `highlight.ts`, `oauth-clients.json` resolve to nothing. Already fixed since GL-366 was filed: the "no automated test suite" paragraph is gone and §3 lists `bun run test`. `openspec instructions specs|design|tasks --json` return `rules: undefined`; the proposal rules load because none of them contains an unquoted colon.

## Goals / Non-Goals

**Goals:**
- Every claim in the touched docs matches the tree at the change's commit, with evidence in the PR.
- All four OpenSpec rule sets reach the CLI.

**Non-Goals:**
- Reorganising the docs, adding new rules, or changing the roadmap's decisions.

## Decisions

1. **Edit against evidence.** Each changed claim cites the file or symbol it now describes; the CLAUDE.md path check (resolve every backticked `*.ts/*.tsx/*.rs/*.md/*.json/*.toml` reference with `find`) runs before and after, and its "missing" list must be empty after.
2. **Quote each offending `config.yaml` entry** with double quotes (escape inner quotes), not block scalars, so the diff stays one line per rule and the wording is byte-identical. Verify with `openspec instructions design --change refresh-architecture-docs --json` showing a populated `rules` array and no warning on any command.
3. **Roadmap gets a status block, not an edit of the phases.** The document is a decision record; an ADR-style "Status (2026-09): phases 1–3 done, phase 4 partially shipped as the `gh` preflight, native token + OAuth shipped for GitLab/Bitbucket under GL-132/GL-139, phases 5–8 undecided" keeps history legible and stops readers from planning against it as current.
4. **CLAUDE.md stays the map, the rules stay the checklist** — no merging, no splitting; the store list and layout section are corrected in place.

## Risks / Trade-offs

- [Docs drift again within weeks] → this change adds "verify quoted paths resolve" to the PR checklist text in `architecture-rules.md` §3; a `scripts/check-doc-paths.mjs` that fails CI on a dangling backtick path is the durable fix and is left as a follow-up so this change stays docs-only.
- [Quoting changes rule wording] → review the `config.yaml` diff for added quote characters only.
- [Line references in GL-366 have moved] → resolve each by symbol, not line, before editing.
