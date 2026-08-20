## Context

See `proposal.md` for motivation and the two delta specs for behavior. Today `PrConversation` owns a textarea used for comments and reviews, `ReviewThreadControls` owns a second reply textarea, and both route through the pulls store to typed Tauri commands and `GithubProvider` write methods. The PR header already opens the provider-supplied `pr.url` through the validated external URL path.

The change is cross-cutting because removing the UI alone would leave callable comment IPC and provider code behind. The affected Rust and TypeScript files are in the size look band, but this work mostly deletes code and does not justify a module split.

## Goals / Non-Goals

**Goals:**

- Make every PR discussion surface read-only while keeping current reads intact.
- Preserve bodyless approval and thread resolution without retaining a generic text-review contract.
- Remove comment/reply capabilities through the full UI-to-provider path.
- Reuse the existing PR URL and external opener.

**Non-Goals:**

- Generalizing forge capabilities or URLs.
- Changing discussion pagination, rendering, or provider authentication.
- Adding a deep link to a provider-specific comment editor.

## Decisions

### Delete text composers and keep the remaining controls narrow

Remove the conversation textarea and Comment/Request changes actions from `PrConversation`. Keep a bodyless Approve action for open PRs whose provider already supports it, and show an explicit "Open on <provider>" handoff beside the read-only conversation. Remove the reply form from `ReviewThreadControls` while retaining its resolve/reopen button.

The handoff uses `pr.url`, `openExternalUrl`, existing forge naming, and the current toast error behavior. It does not construct URLs or add a new opener. The pulls Zustand store remains the owner of surviving async writes; no new store or folder-module split is due.

Alternative considered: keep the composer and hide only its Comment button. Rejected because the textarea would still author review text, Request changes inherently posts text, and the UI would keep most of the complexity being removed.

### Replace the generic review write with approval only

Narrow `review_pull_request(path, number, action, body, account)` to an approval-only IPC command and provider method with no action or body. GitHub, GitLab, Bitbucket, and Origin already have approval paths; each implementation keeps only that branch. This makes unsupported review text impossible below the UI instead of relying on hidden controls.

The surviving IPC contract stays aligned:

1. Forge implementations expose bodyless approval and remove comment/reply implementations.
2. `commands/github.rs` and `src-tauri/src/lib.rs` register only approval and thread-resolution writes.
3. No Rust serde payload type is needed; remove the frontend `ReviewAction` union because the wire no longer accepts an action.
4. `src/lib/api/github.ts` exposes approval without `action` or `body`, and the pulls store mirrors that signature.

Alternative considered: keep the generic command and reject all values except `approve`. Rejected because it preserves dead flexibility and user-text parameters at the IPC boundary.

### Delete comment and reply paths end to end

Remove the top-level comment and thread-reply commands from the handler list, typed API, pulls store contract/actions/pending keys, provider trait, provider implementations, and forge CLI/API helpers. Keep comment and thread reads unchanged.

Alternative considered: leave the backend paths for future UI use. Rejected because the product decision is to delegate comments to providers; unused callable writes would be maintenance and security surface with no user value.

### Reconcile the concurrent Origin collaboration plan before apply

`openspec/changes/complete-origin-pr-collaboration` currently proposes adding Origin comments and optional approval bodies. Those parts conflict with this change. Before implementation, remove or supersede its comment/review-body tasks and requirements; its unrelated checks and submitted-review reads can continue.

## Risks / Trade-offs

- [Users lose fast in-app replies and request-changes reviews] → Keep discussion visible and place the provider handoff at the point where the removed controls were.
- [A provider URL is absent or invalid] → Reuse the existing validated opener and visible error path; do not guess a URL.
- [A removed wrapper remains registered or a surviving approval signature drifts] → Update all IPC layers together and retain command-registration coverage.
- [The concurrent Origin proposal reintroduces comment writes] → Reconcile its conflicting artifacts before applying either change.

## Migration Plan

1. Reconcile the conflicting comment/review-body scope in `complete-origin-pr-collaboration`.
2. Remove frontend text entry points and expose the provider handoff plus bodyless approval.
3. Delete comment/reply plumbing and narrow review to approval across IPC and providers.
4. Run focused tests, full frontend/Rust checks, and manually verify read-only discussion, approval, thread resolution, and external opening.

Rollback is a normal code revert; there is no persisted data or schema migration.
