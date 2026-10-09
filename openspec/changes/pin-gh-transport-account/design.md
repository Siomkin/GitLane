# Design

## Context

Engine: **git CLI write layer**. Transport runs real `git` (fetch / pull /
push / clone). The account binding is resolved in `git/transport_auth.rs`, and
`git/credential_bridge.rs::git_invocation` turns it into `-c` config plus env.
`write/remotes/transport.rs::run_transport` and `write/lifecycle/clone.rs`
consume that result.

Today the resolution of `GitTransportAuthRef::GithubGh { account_ref, .. }`
checks the account host, then returns `TransportCredential::Gh { host }`,
dropping `account_ref.login`. `gh_helper_config(host)` emits:

```
-c credential.https://<host>.helper=
-c credential.https://<host>.helper=!gh auth git-credential
```

`gh auth git-credential` answers only for gh's active account (see
proposal.md, Why). Git children never inherit `GH_TOKEN` and its siblings
(`write/cli/command.rs::PROVIDER_TOKEN_ENV_VARS`). That is correct and stays
as it is: hooks must not see a token.

The PR path already gets this right, and this design reuses its approach:
`forge/cli/accounts.rs::token_for` runs
`gh auth token --hostname <host> --user <login>`, and
`forge/cli/command.rs::run_gh_command` exports the result as both `GH_TOKEN`
and `GH_ENTERPRISE_TOKEN` on one `gh` child.

## Goals / Non-Goals

**Goals:**
- Transport authenticates as the bound login, whatever account gh has active.
- The token lives only in the helper's `gh` process. It never reaches git, a
  hook, IPC, or the frontend.
- A missing token for the bound login fails closed.

**Non-Goals:**
- IPC, TS wrappers, Zustand stores, and UI stay unchanged.
  `GitTransportAuthRef` already carries `account_ref`.
- No change to the `credential_bridge` askpass path, `glab`, or
  provider-token modes.

## Decisions

### D1. Pin inside the credential helper, not in git's environment

`gh_helper_config(host, gh_host, login)` emits a shell-function helper:

```
credential.https://<host>.helper=
credential.https://<host>.helper=!f() { [ "$1" = get ] || exit 0; t=$(gh auth token --hostname '<gh-host>' --user '<login>' </dev/null) && [ -n "$t" ] || exit 1; GH_TOKEN="$t" GH_ENTERPRISE_TOKEN="$t" exec gh auth git-credential "$@"; }; f
```

- Only `get` resolves a token. gh's `store`/`erase` are no-ops, so they
  exit 0 without a keychain read. The lookup reads `/dev/null`, so git's
  credential request on stdin reaches `gh auth git-credential` intact.
- Every git child already drops inherited `SHELLOPTS`/`BASHOPTS`
  (`write/cli/command.rs`). Otherwise an exported `xtrace` would make
  bash-backed `/bin/sh` print `t=<token>` to git's stderr.
- `credential_for_remote` / `credential_for_url` run gh's capability
  baseline (`forge::ensure_gh_supported`) before returning `Gh`. A gh without
  `auth token --user` therefore gets gh's upgrade message instead of a
  misleading auth failure. The pure resolver its unit tests call never spawns
  gh.

- Git runs `!` helpers through `sh` (also on Git for Windows) and appends the
  action (`get` / `store` / `erase`) as `"$@"`. `gh auth git-credential` keeps
  owning the credential protocol, including `x-access-token` and the no-op
  store and erase.
- When a token is pinned, gh answers with it whatever username git sends.
  This was verified empirically on gh 2.102.0.
- Exporting both token names matches `run_gh_command`, so GHES hosts are
  pinned too.
- **Fail closed:** `&& [ -n "$t" ] || exit 1`. An empty `GH_TOKEN` would make
  gh fall back to the active account, which is the bug we are fixing. When the
  helper exits non-zero, git falls through to its prompt, which is disabled for
  GitLane's children, and the operation ends in git's normal auth failure.
- `<gh-host>` is `account_ref.host` with the scheme stripped, the same
  normalization `token_for` uses (`forge::domain::host_without_scheme`). The
  `credential.https://<host>` scope keeps using the remote's credential host,
  port included, exactly as today.

Alternatives considered:
- **Export `GH_TOKEN` on the git child.** Smallest diff, but every hook git
  runs (pre-push, and any hook that reaches the network) would inherit the
  token. Rejected. `PROVIDER_TOKEN_ENV_VARS` exists to prevent exactly this.
- **Route gh through the `GIT_ASKPASS` credential bridge** (as
  `ProviderToken` does): the parent resolves the token and a command-scoped
  broker hands it to the askpass child. This avoids interpolating into a shell
  string, but it adds a gh-backed token source and broker plumbing, and the
  token gets resolved even when git never asks. Kept as the fallback if review
  rejects interpolation.
- **`gh auth switch`** before each operation. Rejected: it mutates global
  state, races between tabs, and contradicts the multi-account model in
  CLAUDE.md.

### D2. Carry the login in `TransportCredential::Gh`

`Gh { host }` becomes `Gh { host, gh_host, login }`. `host` keeps scoping the
helper to the remote's credential authority, and `gh_host` is the account's
own gh hostname. They differ for a `www.github.com` remote bound to a
`github.com` account, and gh only knows the latter. It stays non-secret, and the
`TransportCredential` invariant ("carries no secret") holds. The login comes
from the `account_ref` that `credential_for_credential_host` already
validates against the remote host. The resolver validates it (D3) and returns
`Err` before any git command is built. `credential_for_remote` and
`credential_for_url` already surface those errors to the command layer.

### D3. Validate every value interpolated into the helper string

- **Login:** 1–100 chars, `[A-Za-z0-9._-]`, not starting with `-`. This
  covers github.com, EMU (`name_shortcode`), and GHES. A failure produces
  "GitHub account binding is invalid; choose the account again." (the same
  tone as `token_for`).
- **gh host:** `account_ref.host` already passes
  `validate_credential_authority`. That check rejects `/` (so no scheme
  survives) and allows only `[A-Za-z0-9.-]` with an optional `:port`, or a
  bracketed IPv6 literal, which is already shell-quote-safe. It is reused rather
  than duplicated. `gh_host` is then normalized with the PR path's
  `forge::host_without_scheme`, so both paths ask gh for the same hostname.
- Both values are single-quoted in the helper. With `'` excluded by the
  charsets, single quoting is total.
- Validation lives in `transport_auth.rs` next to
  `validate_credential_authority`, a pure function with unit tests. It does
  not live in the string builder, so an invalid value never becomes a
  `TransportCredential`.

### D4. No frontend or IPC change

Four IPC layers: none change. `GitTransportAuthRef` (types), the commands, and
the TS wrappers already carry `account_ref.login`. Zustand store: none. Error
copy: unchanged. A fail-closed helper produces git's ordinary auth error,
which `src/lib/gitError.ts` already classifies.

## Risks / Trade-offs

- [Shell interpolation in a `!` helper is a new injection surface] → D3's
  strict charsets plus single quoting, and a malicious-login unit test (spec
  scenario).
- [`gh auth token` runs once per credential request, about 30 ms with keyring
  access] → It is negligible next to a network round-trip. Git asks once per
  operation.
- [A future gh might stop honouring `GH_TOKEN` in `auth git-credential`] →
  Add a `#[ignore]`d integration probe, or note this in the capability
  baseline docs. The PR path relies on the same `GH_TOKEN` contract.
- [macOS keychain prompts when the helper's `gh` reads an inactive account's
  token] → gh already reads that token through the same binary for the PR
  path, so the keychain ACL already allows it.
- [`credentials.rs::helper_display_label` matches the literal
  `!gh auth git-credential`] → That function classifies the user's own
  configured helpers. The injected `-c` helper is never read back through it,
  so no change is needed.

## Migration Plan

None. The change is backend-only and stateless. Existing bindings
(`account_ref.login`) already carry the login. Rollback is a revert.

## Size ceiling

Both production halves stay under the 400-line ceiling. The new end-to-end
test pushed `credential_bridge.rs`'s inline test half over it (466 lines), so
the `git_integration` test module moved to `credential_bridge/git_integration.rs`
beside `broker.rs`. `bun run sizes` is OK after the move.
