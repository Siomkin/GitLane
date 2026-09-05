## Context

`release.yml:448` (`if: runner.os == 'macOS' && secrets.APPLE_CERTIFICATE != ''`) and `release.yml:633` (`if: secrets.APPLE_CERTIFICATE == ''`) came in with #401. GitHub's context-availability rules do not allow the `secrets` context in `jobs.<id>.if` or `jobs.<id>.steps[*].if`, so the file is rejected when GitHub evaluates triggers; it records a failed run with zero jobs ("This run likely failed because of a workflow file issue") for every push, and will do the same for a tag push. `gh run list --workflow release.yml` shows push failures on every branch from 2026-09-04; the last successful tag run is v2.3.1 (2026-09-03, before #401). `actionlint` 1.7.7 (run through its Docker image during the audit) confirms it verbatim: `release.yml:448:37: context "secrets" is not allowed here. available contexts are "env", "github", "inputs", "job", "matrix", "needs", "runner", "steps", "strategy", "vars"` and the same at `:633:13`; the only other finding is a shellcheck SC2016 info at `:565`, which is why the CI lint starts with shellcheck off.

Constraints that shape the fix: `preflight` already runs first on the Mac runner and already refuses to run without the updater signing key; `release-app` is a four-leg matrix; `publish-release` is GitHub-hosted and already consumes `needs.preflight.outputs.release_tag`; `concurrency.group: release` serialises runs; the self-hosted runner policy and the `pull_request_target` trust gate in `ci.yml` must not change.

## Goals / Non-Goals

**Goals:**
- The workflow validates on every trigger; a tag push starts jobs; a branch push creates no run.
- One place decides "signing configured", and both consumers read that one decision.
- This class of error (invalid expression, wrong context) fails in PR CI, not at release time.

**Non-Goals:**
- Changing signing or notarisation mechanics, runner placement, or app code.
- Turning on shellcheck-level linting of the 785-line release file in this change (measured as a follow-up).

## Decisions

1. **Decide once in `preflight`, export a boolean.** Add a step `Detect Apple signing material` with `env: APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}` and `run: echo "apple_signing=$([ -n "$APPLE_CERTIFICATE" ] && echo true || echo false)" >> "$GITHUB_OUTPUT"`, surfaced as `jobs.preflight.outputs.apple_signing`. Consumers: the `release-app` export step becomes `if: runner.os == 'macOS' && needs.preflight.outputs.apple_signing == 'true'`; the `publish-release` label step becomes `if: needs.preflight.outputs.apple_signing != 'true'`. The partial-configuration guard (exit 1 when `APPLE_CERTIFICATE` is set but a sibling secret is empty) stays inside the export step unchanged.
   - Alternative (a): keep each step unconditional and test `$APPLE_CERTIFICATE` in the shell — works, but duplicates the decision in two jobs and leaves a "succeeded" step that did nothing, hiding misconfiguration.
   - Alternative (b): a repository variable `vars.APPLE_SIGNING_ENABLED` (allowed in `if:`) — introduces a second source of truth that can disagree with the secret.
   - Secret handling: the p12 and passwords remain step `env:` exactly as today; only `true|false` crosses the job boundary.
2. **Lint workflows in CI with actionlint.** Add to `security-js` (GitHub-hosted, already gated by the `security` filter, read-only token): download the pinned actionlint release tarball, verify its sha256, run `actionlint -shellcheck= -pyflakes=` (expression and schema checks only) so the existing shell bodies do not block the guard. No marketplace action is added (the repo pins every action by SHA and has no `go`). Alternative: the `rhysd/actionlint` container — needs Docker on the runner and is slower.
3. **SHA-pin the three remaining tag refs in the same PR.** Same hygiene class, no behaviour change; Dependabot's `github-actions` group already maintains SHA pins with `# vN` comments.

## Risks / Trade-offs

- [`preflight` is skipped on a `manifest_only` dispatch, so its output is empty] → `publish-release` is skipped in that mode too and `rollback-beta-manifest` does not read the flag; verified by a `manifest_only` dry run in task 4.2.
- [actionlint flags pre-existing issues in `ci.yml`/`docs.yml`/`labeler.yml`] → run it locally first (task 1.1); fix or `-ignore` per pattern with a comment; the PR must reach a clean run, not a filtered one.
- [Fork PRs (`pull_request_target`) lint contributor YAML] → actionlint is read-only and runs GitHub-hosted with the same posture as `bun audit`.
- [A release tag is pushed before this merges] → the run fails at trigger; delete and re-push the tag after merge (documented in the runbook).

## Migration Plan

1. Merge to `latest`; confirm the merge push produces no Release run and the new lint step is green.
2. With a Mac runner online (per `CLAUDE.local.md`), push a beta tag (`vX.Y.Z-beta.N`) and confirm `preflight` starts, the macOS leg takes the signed path only when `apple_signing == 'true'`, and the "unsigned" label appears only when it is `false`.
3. Rollback: revert the PR. Note that reverting #401's two `if:` lines alone also restores validity; reverting the whole of #401 is not required.

## Open Questions

- Whether to enable shellcheck inside actionlint after the first green run — deferrable; it changes neither the spec nor the task breakdown.
