## Why

In-app pull-request commenting duplicates each forge's collaboration UI and expands GitLane's provider write surface for little benefit. GitLane should keep pull-request discussion readable while sending users to the provider's PR page when they want to comment.

There is no Jira key for this change.

## What Changes

- **BREAKING** Remove free-form PR writing from GitLane: top-level comments, review-thread replies, request-changes reviews, comment-only reviews, and comment bodies attached to reviews.
- Keep existing discussion comments and review threads readable in the app.
- Keep non-comment actions that do not require authored text, including bodyless approval and resolving or reopening an existing thread.
- Replace comment/reply controls with a visible "Open on <provider>" action that reuses the selected PR's existing provider URL and validated system-browser path.
- Remove the now-unused frontend store/API and Rust IPC/provider comment-write paths instead of leaving hidden dead functionality.
- Do not add a replacement editor, provider capability registry, dependency, or authentication flow.

## Capabilities

### New Capabilities

- `pull-requests/detail`: Define the provider-neutral read-only discussion surface and external-provider handoff for PR collaboration.

### Modified Capabilities

- `forge/origin`: Remove in-app Origin thread replies and keep Origin discussion interaction available through the existing external PR link.

## Impact

- Processes: React frontend, Zustand pulls store, typed IPC API, Rust Tauri commands, and forge provider implementations/traits.
- Existing patterns: reuse `PrHeaderActions`/`openExternalUrl` and `pr.url`; no new URL builder or opener path.
- IPC: delete comment/reply commands and narrow review submission to bodyless approval, keeping every surviving provider contract layer in sync.
- Auth/secrets: risk decreases because GitLane sends less user-authored content to forge CLIs/APIs; provider tokens remain backend-only and no secret handling changes.
- Dependencies: none.

## Non-goals

- Removing PR discussion, review-thread, or review-status reads.
- Removing PR creation, lifecycle, merge, checks, commits, or diff features.
- Rebuilding provider discussion UI, deep-linking to a specific comment editor, or introducing per-provider commenting capabilities.
- Changing authentication, stored accounts, or git transport credentials.
