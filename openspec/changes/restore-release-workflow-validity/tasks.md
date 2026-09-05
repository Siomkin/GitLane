## 1. Reproduce the diagnostic

- [x] 1.1 Re-run actionlint (`docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 .github/workflows/*.yml`, or `brew install actionlint`) on the branch before editing; verify it reports `context "secrets" is not allowed here` at `release.yml:448` and `:633` (the audit saw exactly these two plus one SC2016 info at `:565`), and record every finding in the PR description

## 2. Release workflow

- [x] 2.1 Add the `Detect Apple signing material` step to `preflight` (secret via `env:`, boolean via `$GITHUB_OUTPUT`) and declare `outputs.apple_signing`; verify actionlint parses the file and `gh workflow view release.yml --yaml` (after merge) shows the output
- [x] 2.2 Change the `release-app` export step's `if:` to `runner.os == 'macOS' && needs.preflight.outputs.apple_signing == 'true'`, leaving the partial-configuration exit-1 guard inside the step; verify actionlint is clean and `git diff` on that step shows only the `if:` line
- [x] 2.3 Change the `publish-release` label step's `if:` to `needs.preflight.outputs.apple_signing != 'true'` and ensure `preflight` is in that job's `needs`; verify actionlint is clean
- [ ] 2.4 Push the branch and verify the push creates no Release run (`gh run list --workflow release.yml --limit 3` shows none for the branch)

## 3. CI guard and action pinning

- [x] 3.1 Add an actionlint step to `security-js` in `ci.yml` (pinned tarball + sha256 check, `-shellcheck= -pyflakes=`); verify the step fails on a scratch commit that re-introduces `secrets.X` in an `if:` and passes on the fixed tree
- [x] 3.2 Pin `actions/checkout@v5`, `oven-sh/setup-bun@v2`, and `cloudflare/wrangler-action@v4` to full commit SHAs with `# vN` comments; verify `grep -rn 'uses: .*@v[0-9]' .github/` returns nothing

## 4. Runbook and release verification

- [x] 4.1 Update `docs/release-channels.md` (pre-tag checklist: CI green on `latest` including workflow lint; if a tag was pushed while the workflow was invalid, delete and re-push it) and the `bump-version` skill's checklist; verify the `docs.yml` workflow passes
- [ ] 4.2 With a Mac runner online, push a beta tag and verify `preflight` starts, the macOS leg exports signing env only when `apple_signing == 'true'`, `latest.json` is assembled, and the release notes carry "macOS build is unsigned" only when secrets are absent; also dispatch with `manifest_only` and verify the skipped-`preflight` path still completes
- [ ] 4.3 Definition of done: `openspec validate restore-release-workflow-validity --strict` passes and `ci.yml` is green on the PR including the new lint step
