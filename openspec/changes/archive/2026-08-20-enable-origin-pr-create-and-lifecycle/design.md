## Context

See `proposal.md` for motivation and `specs/forge/origin/spec.md` for observable behavior. Origin already participates in the provider-neutral pull-request trait and the frontend already owns create and lifecycle flows, but `OriginProvider` returns unsupported errors for those methods and frontend capability gates hide their controls. The shared external opener validates URLs but discards the asynchronous Tauri opener result.

The installed Origin CLI exposes direct `pr create`, `pr close`, `pr reopen`, and `pr ready` commands. Origin credentials remain owned by that CLI session.

## Goals / Non-Goals

**Goals:**

- Extend the existing Origin provider with the minimum direct CLI argument builders and executions required by the existing trait.
- Reuse the existing IPC commands, types, pull-request store actions, dialog, pending-state tracking, confirmations, and refresh behavior unchanged.
- Keep merge-strategy capability separate from lifecycle capability so Origin gains state actions without gaining rebase or delete-branch options.
- Preserve the synchronous URL-validation result while giving the PR surface a way to report asynchronous system-opener failures.

**Non-Goals:**

- General provider-capability negotiation or a new capability model.
- New Origin API/REST mutations when the CLI already exposes a direct command.
- Any new secret, IPC, store, dependency, or Tauri permission.
- Refactoring existing oversized test files beyond adding focused cases at their current seams.

## Decisions

### Use direct Origin CLI subcommands behind the existing provider boundary

Add pure argument builders and small execution functions in the existing Origin operations module, then implement `OriginProvider::create_pr` and `OriginProvider::set_pr_state` by delegating to them. Creation passes repository, head, base, title, body, and an explicit `--status open` or `--status draft`; the explicit status is required because Origin's CLI default is draft while GitLane's existing form default is open. State actions map only `close`, `reopen`, and `ready` to their matching CLI subcommands.

Alternative considered: call Origin's REST API. Rejected because the direct CLI commands already define the supported user-facing contract and keep authentication inside the existing single subprocess boundary.

### Reuse the current IPC contract unchanged

The existing `create_pull_request` and `set_pull_request_state` Tauri commands already dispatch through the selected provider, and their input/output types cover Origin. No command declaration, handler registration, serde type, or TypeScript API wrapper changes are needed; implementation work stays behind the provider trait.

Alternative considered: add Origin-specific Tauri commands. Rejected because it would duplicate the provider-neutral IPC and frontend flows.

### Split only the frontend booleans that currently conflate capabilities

Add Origin to the existing create-provider set. In the PR header, retain the current basic-merge behavior for Origin while allowing Origin lifecycle controls and Close; GitLab and Bitbucket remain unchanged. Prefer the smallest explicit booleans/props at the existing action composer instead of introducing a provider-capability registry.

Alternative considered: replace every provider conditional with a generalized capability object. Rejected as unnecessary for four providers and outside this change.

### Keep the shared external opener and expose its asynchronous failure locally

Keep scheme validation and Tauri/browser selection in `openExternalUrl`. Preserve its current boolean return for immediate validation and add the smallest error-reporting hook for the Tauri `openUrl` promise. The PR action passes the existing toast function, handles a false validation result, and reports a rejected opener promise. Other call sites remain behaviorally unchanged.

Alternative considered: add an Origin backend operation that runs `origin pr view --web`. Rejected because the shared opener already owns browser launching, the existing Origin URL format matches the CLI route, and a new IPC path would duplicate established behavior.

### Keep validation focused at existing seams

Rust tests assert the exact create and state argument vectors, including explicit status and repository selection. Frontend tests exercise Origin create capability, lifecycle visibility/action dispatch, and both successful and rejected external-link clicks. The Origin operations file has about 280 non-test lines, so the additions should remain below the Rust size ceiling without a new module; `bun run sizes` will enforce the ratchet.

## Risks / Trade-offs

- [Origin CLI commands differ on an older installed version] → Let the exact command fail through the existing Origin-specific error path; do not make read-only PR support depend on every new write subcommand.
- [Creation output is not a URL] → The existing create flow does not require an Origin PR number for stacking, and the refreshed list remains authoritative.
- [An opener rejection contains platform-specific text] → Prefix it with concise GitLane context and retain the underlying error for actionability.
- [Lifecycle and merge gates drift together again] → Cover Origin and existing basic providers with focused UI tests that assert their different control sets.

## Migration Plan

No data migration or rollout flag is required. Ship the provider and UI changes together; rollback restores the previous hidden/unsupported behavior without changing repository or credential state.
