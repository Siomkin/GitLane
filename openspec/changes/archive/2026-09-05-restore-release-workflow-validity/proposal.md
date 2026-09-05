## Why

Since #401 (`7e601611`, 2026-09-04) `.github/workflows/release.yml` gates two steps on `secrets.APPLE_CERTIFICATE` inside `if:` expressions (`release.yml:448` and `:633`). GitHub does not make the `secrets` context available to `if:` at job or step level, so the workflow file no longer validates: every push to any branch now spawns a failed "workflow file issue" Release run with zero jobs (13 of the last 30 Release runs, all after #401; the last good tag run is v2.3.1 on 2026-09-03), and the next `v*` tag push will fail before `preflight` starts. The release pipeline is broken until this lands.

No Jira key (GL-xx) for this change. Touches CI only (`.github/workflows/release.yml`, `.github/workflows/ci.yml`, tag-pinned `uses:` in `docs.yml`/`labeler.yml`); no Rust, frontend, or IPC change.

## What Changes

- Move the "is Apple signing configured" decision out of `if:` expressions into one `preflight` step that receives the secret through `env:` and writes a boolean (`apple_signing=true|false`) to `$GITHUB_OUTPUT`, exported as a job output. `release-app` (the macOS export step) and `publish-release` (the "unsigned" release-notes label) gate on `needs.preflight.outputs.apple_signing`. The secret value stays inside step `env:`; only the boolean crosses jobs.
- Add a workflow lint (`actionlint`) to the GitHub-hosted `security-js` job in `ci.yml` — its `security` path filter already matches `.github/workflows/**` — so an invalid expression fails the PR instead of the next release.
- Pin the remaining tag-referenced actions (`actions/checkout@v5` ×2, `oven-sh/setup-bun@v2` ×2, `cloudflare/wrangler-action@v4`) to commit SHAs, matching every other `uses:` in the tree.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `platform/security`: the requirement "macOS release builds are signed with a Developer ID and notarised" gains the invariant that the signing gate is decided at run time from secret presence, that the release workflow starts on every release tag regardless of secret configuration, and that a non-release push produces no Release run.

## Impact

- CI: `.github/workflows/release.yml` (`preflight` outputs; `release-app` export step `if:`; `publish-release` label step `if:` + `needs`), `.github/workflows/ci.yml` (`security-js` gains the lint step), `.github/workflows/docs.yml` and `labeler.yml` (SHA pins).
- Docs: `docs/release-channels.md` pre-tag checklist and the `bump-version` skill gain "CI green on `latest`, including workflow lint; a tag pushed while the workflow was invalid must be deleted and re-pushed".
- Secrets/auth/IPC risk: none new. Apple signing secrets remain GitHub Actions secrets consumed only through `env:` on the steps that already use them; the job output is a boolean, never the secret. No IPC change; no provider token is involved.
- Pattern to copy: `ci.yml`'s `changes` job already exports one policy decision (`runner`, `trusted`) as job outputs "so the downstream jobs cannot drift" — the signing flag follows that exact shape.

## Non-goals

- Changing what is signed or notarised, or how (the `tighten-tauri-security-config` design and GL-96 stand).
- Windows Authenticode signing.
- Moving release legs off the self-hosted Mac runners (a separate backlog decision).
- Re-running or re-tagging past releases.
