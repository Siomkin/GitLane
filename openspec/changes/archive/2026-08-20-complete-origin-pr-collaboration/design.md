## Context

See `proposal.md` for motivation and `specs/forge/origin/spec.md` for behavior. The current provider already routes every Origin operation through `forge::context()` and the single `run_origin` subprocess boundary. Its provider-neutral contract, IPC commands, pulls store, Checks tab, and discussion/review composer already cover the requested operations, but `OriginProvider` returns an empty check list, rejects comment/review writes, emits no submitted reviews in detail, and the frontend hides the whole composer for Origin.

The current Cursor documentation and installed Origin CLI `2026.08.15-22-58-04-922a05a` expose `pr checks --json`, `pr comment`, and `pr review --approve`. The same CLI explicitly labels request-changes unsupported (`-r, --request-changes ... (not supported by Origin yet)`) while `-c, --comment` is supported.

The local CLI is signed in, so argument contracts and JSON field names were verified live against a real Origin repository: `pr checks --json` accepts `name`, `status`, and `conclusion`, and `pr view --json` accepts `reviews` and `latestReviews`. No reachable repository currently has an open pull request, a CI check run, or a submitted review, so the *shape* of a populated checks or reviews payload and all in-app behavior remain unverified.

## Goals / Non-Goals

**Goals:**

- Reuse the existing provider trait, IPC, store ownership, resource loading, and UI instead of adding Origin-specific paths.
- Keep every command pinned to the selected pull-request number and `org/name` repository.
- Normalize Origin check and review vocabulary into GitLane's existing shared wire types.
- Keep new Origin DTO and operation responsibilities below the Rust file-size ceiling.

**Non-Goals:**

- Expanding the global Origin capability probe so an older CLI's missing collaboration command blocks otherwise-supported read operations.
- Widening `PrCheck`, `PrReview`, `PullRequestDetail`, or any TypeScript/IPC type.
- Treating CLI field probes as a substitute for in-app QA against a pull request that has real checks and a real submitted review.

## Decisions

### Implement checks behind the existing lazy `pr_checks` provider method

Add an Origin checks operation that runs:

`origin pr checks <number> --json name,status,conclusion -R <owner/repo>`

The three field names are validated by the CLI, which rejects unknown fields and reports the full set as `id`, `name`, `description`, `status`, `conclusion`, `detailsUrl`, `startedAt`, `completedAt`, and `group`. A pull request with no CI returns `[]`.

Deserialize the returned list into a small Origin-only DTO and map it to the existing `PrCheck { name, state }` contract. Map `success` to pass; `failure` and `cancelled` to fail; `neutral` and `skipped` to skipped; and everything else — a missing conclusion, a queued or in-progress check, **and any conclusion string this change does not recognize** — to pending.

Origin publishes no check status/conclusion vocabulary in its documentation, and no reachable repository has a check run to sample, so the recognized values above are inferred. Unknown values therefore resolve to pending rather than fail: a vocabulary GitLane has not seen must not paint a passing pull request red. Widen the recognized set once a real payload is observed.

Origin groups check runs (`ciState` is `{ "checkRunGroups": [...] }`, and each check carries a `group`). GitLane's `PrCheck` has one `name` field, so render `group / name` when `group` is present and non-empty, and the bare `name` otherwise — check names are only unique within a group.

Alternative considered: read only `ciState` from `origin pr view`. Rejected because it is an aggregate and cannot populate the existing per-check list.

### Use direct CLI writes for comments and approvals

Implement `OriginProvider::comment_pr` with `origin pr comment <number> -F - -R <repo>` after rejecting an empty body. Implement `OriginProvider::review_pr` only for `approve`, using `origin pr review <number> --approve -R <repo>`, adding `-F -` when the body is non-empty. Reject `request-changes`, `comment`, and unknown actions with an Origin-specific message before spawning a subprocess.

Both subcommands accept `-F, --body-file` with `-` for stdin. Pipe the body there instead of passing `-b <body>`: user-authored comment text stays out of the process argument list and out of any command echo in an error path.

The two rejected review actions are rejected for different reasons, and the messages should say so. `request-changes` is unavailable in the CLI itself. A formal comment-only review (`pr review -c`) *is* supported by the CLI and is deferred purely because GitLane's shared composer has no comment-only review action to dispatch — a top-level comment is the equivalent surface.

Alternative considered: issue REST mutations through `origin api`. Rejected because first-class CLI commands already preserve the intended CLI-session authentication boundary and define the supported public behavior.

### Load submitted review verdicts from `pr view --json reviews`

During Origin pull-request detail loading, run:

`origin pr view <number> --json reviews -R <owner/repo>`

Map each entry's verdict to the existing shared review states; a review carrying dismissal metadata maps to dismissed. Attach the results to `PullRequestDetail.reviews`, leaving reviewer requests, assignees, labels, and milestones unchanged.

This is a second read style for the Origin provider, which otherwise reads through `origin api`. That is deliberate: **there is no reviews REST endpoint.** `origin api /repos/{owner}/{repo}/pulls/<number>/reviews` returns the `{ "pullRequest": { ... } }` envelope rather than a review list — the same fallback behavior `ops.rs` already documents for `/pulls/{n}/comments` — and the detail endpoint `/repos/{owner}/{repo}/pulls/<number>` returns no reviews key at all. `pr view --json` is the only validated source, and it exposes no pagination flag, so it returns whatever Origin considers the full set.

`reviews` is preferred over the sibling `latestReviews` field so a reviewer's superseded verdicts are not silently dropped before GitLane's own per-reviewer collapsing runs.

Alternative considered: parse `origin pr view --comments` text. Rejected because plain-text output is presentation-oriented and `--json` supplies stable camelCase JSON from the same command.

### Split new responsibilities at the existing Rust size seam

`origin/ops.rs` already has about 342 production lines and `origin/dto.rs` about 394. Add focused child modules under `origin/ops/` and `origin/dto/` for checks and collaboration/review data, with the current files remaining the provider-facing facades. Parent-private helpers remain reusable by child modules; no new abstraction or provider layer is introduced.

Alternative considered: append everything to the two existing files. Rejected because it would cross the enforced 400-line production ceiling.

### Replace the Origin-wide composer hide with two explicit UI capabilities

Render the existing composer for Origin so discussion comments and approvals reuse current pending state, confirmations, toasts, and refreshes. Keep the Request changes button hidden for Origin while leaving GitHub behavior unchanged. Use the existing forge-kind conditional in `PrConversation`; a generalized capability registry is unnecessary for this one provider difference.

Alternative considered: build an Origin-specific composer. Rejected because it would duplicate the shared action and concurrency behavior.

### Do not widen the global Origin readiness probe

Keep the current `pr diff --patch`, `api`, and `pr thread` baseline. Checks, comment, and review failures from an older CLI remain scoped to the invoked action and flow through the existing Origin-specific error/redaction path.

Alternative considered: require every new subcommand during initial Origin readiness. Rejected because a user with an older CLI should still be able to list and inspect pull requests.

## Risks / Trade-offs

- [Origin is early beta and JSON fields may drift] → Keep DTOs Origin-local, tolerate unknown enum values instead of failing on them, cover payload fixtures, and fail only the affected resource/action.
- [No populated checks or reviews payload has been observed] → Treat the check-conclusion vocabulary and the review-entry shape as provisional: deserialize permissively, map unrecognized values to pending, and confirm both against a real payload during manual QA before considering the mapping settled.
- [`pr view --json reviews` has no pagination flag] → Render whatever Origin returns; the existing compact reviewer metadata surface has no pagination or truncation contract on any provider, so add one only if GitLane gains a review-history surface.
- [A newer CLI later supports request changes] → Keep the unsupported action explicit; a follow-up can enable it without changing this change's check/comment/approval path.

## Migration Plan

No data migration, feature flag, dependency, or permission change is required. Ship the Origin provider and composer gate changes together; rollback restores the current empty Checks tab and hidden composer without altering repository or credential state.
