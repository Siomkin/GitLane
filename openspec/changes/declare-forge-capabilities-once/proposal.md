# Proposal

## Why

The list of which forge supports which pull-request feature is written out by hand in
about ten places: Rust adapter defaults, `forgeHelp.ts` sets, a `BranchContextMenu`
literal, `pulls/list.ts`, the Remotes legend, the Accounts chips, the provider popover
builders, and user-facing copy in `auth_providers/spec.rs`. These copies have already
drifted apart in ways users can see (2026-09-25 audit):

- The branch menu hides "Open a pull request…" on Cursor Origin (P0).
- Settings says Origin PR creation "is not in GitLane yet".
- The Remotes legend says Bitbucket has no PR features.
- Connected GitLab and Origin accounts are labelled "Sign-in only".
- A GHES or glab auth failure tells the user to run `gh auth login --hostname github.com`.
- GitLab, Bitbucket and Origin auth failures lose the `auth` kind, so they never offer
  "Fix authentication…".

Adding a forge today takes coordinated edits in about eight files. No Jira issue exists yet.

## What Changes

- The backend declares each forge's pull-request capabilities once. `ForgeIdentity` gains a
  `capabilities` record (create, merge methods, state actions, delete branch, stacks), and
  the repo forge summary (`RepoForge`) carries it across IPC.
- The frontend derives every gate, legend, chip and menu entry from that record plus one
  presentation table (`FORGES: Record<ForgeKind, {label, noun, Icon}>`). The literal lists
  go away. Settings copy about capabilities is generated from the same source.
- `ForgeKind` becomes the single Rust provider enum: `ForgeProvider` folds into it, and one
  `key()` is used by `PROVIDERS`, the OAuth config table and the keychain namespace.
- Forge auth errors are provider-aware. `NotAuthenticated` carries the host and a
  provider-supplied sign-in hint. GitLab, Bitbucket and Origin return `kind: "auth"` with
  their own wording. glab errors are no longer classified by the gh classifier.
- `auth_providers` runs `glab` and `origin` through their single subprocess sites
  (`run_glab`, `run_origin`). `probe.rs` keeps only `az` and `tea`, using
  `bounded_output::capture`.
- PR commit rows link to the commit on every forge through `commitWebUrl(forge, oid)`.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `forge/origin`: every create-PR entry point is offered on Origin repositories, and Settings copy matches what ships.
- `ipc/commands`: forge authentication failures are categorised `auth` and name the right forge and host.

## Non-goals

- Forge REST transport dedupe. That stays deferred backlog.
- IPC type codegen (tauri-specta or schemars). The capability record is hand-mirrored like
  every other wire type.
- Adding a forge, or changing what any forge can do. Behaviour moves to one declaration and
  stays as it is today, except for the drifted copies listed above.

## Impact

- **Processes:** Rust (`git/forge/service.rs`, `domain.rs`, `forge.rs`,
  `git/types/repo.rs`, `git/types/auth.rs`, `git/oauth/config.rs`, `identity.rs`,
  `auth_providers/*`, `gitlab/transport.rs`, `bitbucket/*`, `origin/*`), IPC (the
  `RepoForge` shape), frontend (`src/lib/forgeHelp.ts`, `lib/prs.ts`, `lib/api/`,
  `store/pulls/list.ts`, `store/accounts`, `components/chrome/overlays/menus/`,
  `components/chrome/settings/*`, `components/chrome/repo-settings/*`,
  `features/pull-requests/*`).
- **IPC:** `RepoForge` gains a `capabilities` field. It is additive and non-secret. The
  four layers (impl, `commands/repo.rs`, `git/types/repo.rs`, and the TS
  `lib/api/git/repo.ts` interface plus zod schema) land together.
- **Secrets/auth:** the only change is error wording and category. No token crosses IPC,
  and transport auth resolution is unchanged. Moving `glab`/`origin` into their subprocess
  sites gains the existing env scrubbing and output bounds.
- **Existing module to copy:** `ForgeIdentity` already carries `pr_noun` through
  `service.rs::provider_for`. `capabilities` sits beside it.
