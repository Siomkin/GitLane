# Provider authentication & git-transport QA matrix (GL-131 / GL-138)

This is the verification checklist for GitLane's provider authentication and git
transport parity. It maps each supported forge to the git operations that must
work and the auth-specific edge cases to check. Automated coverage is noted per
area; the rest is a manual pass to run before shipping auth changes.

## Support level per provider

**Git transport (clone/fetch/pull/push/…) must work for every provider** through
Git-native auth. The currently visible setup paths are intentionally limited to:
provider CLI where GitLane can use one, Git Credential Manager / the configured
Git credential helper for HTTPS, and SSH keys. Older token/OAuth/keychain code
still exists under the hood for compatibility, but those setup methods are not
the primary UI.

- **gh** — GitHub's CLI owns the token; injected inline as `gh auth
  git-credential` per invocation (`Gh` transport credential).
- **keychain** — a GitLane-owned provider token in the OS keychain, fed to git
  via the `GIT_ASKPASS` bridge (`providerToken` transport credential, GL-132).
- **helper** — the user's own Git credential helper / GCM (`credentialHelper` /
  system), optionally seeded once via `git credential approve`.
- **SSH** — the remote URL uses SSH and Git/ssh-agent select the key; GitLane
  does not manage that credential.

| Provider | Classified by | Transport auth | PR/API | In-app sign-in | Sign-out |
| --- | --- | --- | --- | --- | --- |
| GitHub | `github.com` / `*.github.com` (exact) | gh **or** helper/GCM **or** SSH | ✅ via gh; transport-only through GCM/SSH | `gh auth login --web`; HTTPS via GCM/helper; SSH key | `gh auth logout`; helper/key cleanup outside GitLane |
| GitLab | host contains `gitlab` | glab **or** helper/GCM **or** SSH | ✅ basic MR actions via glab; REST fallback needs keychain token | `glab auth login`; HTTPS via GCM/helper; SSH key | `glab auth logout`; helper/key cleanup outside GitLane |
| Bitbucket | `bitbucket.org` / contains `bitbucket` | helper/GCM **or** SSH | ⚠️ implemented only with a GitLane-owned keychain token, currently hidden from setup UI | GCM/helper for HTTPS; SSH key | helper/key cleanup outside GitLane |
| Azure Repos | `dev.azure.com` / `ssh.dev.azure.com` / `*.visualstudio.com` | az account signal **or** helper/GCM **or** SSH | ❌ | `az login`; HTTPS via GCM/helper; SSH key | `az logout`; helper/key cleanup outside GitLane |
| Gitea | host contains `gitea` | helper/GCM **or** SSH | ❌ | GCM/helper; SSH key | helper/key cleanup outside GitLane |
| Forgejo | `codeberg.org` / contains `forgejo` | helper/GCM **or** SSH | ❌ | GCM/helper; SSH key | helper/key cleanup outside GitLane |
| Cursor Origin | `origin.cursor.com` | helper/GCM **or** SSH | ✅ read-first scope via `origin` CLI | `origin auth login`; HTTPS via GCM/helper; SSH key | `origin auth logout`; helper/key cleanup outside GitLane |
| Unknown HTTPS | none (`other`) | helper only | ❌ | configured Git credential helper/GCM | helper cleanup outside GitLane |
| SSH (any) | scheme | SSH key (no HTTPS binding) | n/a | SSH key | remove key |

Native OAuth sign-in for GitLab (device flow) and Bitbucket (PKCE loopback) is
implemented (**GL-139**) but currently hidden from the primary setup UI while
GitLane narrows visible auth to CLI/GCM/SSH. The flow stores an access token in
the same keychain and authenticates git the same way. It needs a **registered
OAuth app (public client id) per provider/host** — see
`docs/provider-oauth-setup.md` for registration, scopes, and how the client id is
configured (compile-time default + per-host override). Azure's "OAuth" is still
delegated to GCM where present. See also
`docs/github-provider-auth-roadmap.md`.

## Operation matrix (per HTTPS remote)

Run each against a real remote on each provider you can test, once bound to the
intended account:

| Operation | Command surface |
| --- | --- |
| Clone | `clone_repo` (account selected before clone) |
| Fetch (+prune, tags) | `fetch` (per-remote credential) |
| Pull (ff-only) | `pull` |
| Push | `push` |
| Publish branch (set upstream) | `publish_branch` |
| Push tags | `push_tag` |
| Force-push (`--force-with-lease`) | `force_push` |
| Delete remote branch | `delete_remote_branch` |
| Delete remote tag | `delete_remote_tag` |

All nine resolve the **same** `TransportCredential` for the target remote via
`git::transport_auth::credential_for_remote` (clone uses `credential_for_url`),
so verifying one auth path per provider exercises the rest.

## Cross-cutting scenarios

- **Multi-account, one host** — two accounts on `github.com`; each remote's URL
  username selects its own token. Same login on `github.com` + a GHES host stays
  distinct (the GHES host is never collapsed to `github.com`).
- **Custom host/port** — `ghe.example.test:8443`, self-hosted GitLab/Gitea on a
  non-default port: the credential authority preserves `host:port`.
- **Self-managed host** — GitLab/Gitea/Forgejo on a private domain classifies by
  hostname substring; a domain with no marker falls back to the helper path.
- **Separate fetch/push URLs** — a fork-style push URL keeps its own host/path
  when the account/username is rewritten.
- **Azure org scoping** — `dev.azure.com/{org}` and `{org}.visualstudio.com`:
  credentials scope by **org** (`credentialScopePath`), not the repo path, so
  orgs sharing `dev.azure.com` don't collide. `credential.useHttpPath` semantics
  are preserved by passing the org as the credential `path`.
- **Mixed username warning** — a remote whose URL username doesn't match any
  connected account falls back to the credential helper rather than a wrong
  token.
- **SSH remotes** — no HTTPS account binding is offered; auth is the SSH key.
- **Host mismatch** — an account bound to host A against a remote on host B fails
  *before* the network op, with a redacted, actionable message.

## Cursor Origin CLI session

- **PR reads** — with `origin auth status` signed in, an `origin.cursor.com` repo loads
  PR list, detail, commits, comments, and patch diff through `origin`; credentials never
  cross IPC.
- **Existing threads** — reply, resolve, and reopen target the selected PR explicitly;
  creating a new inline thread remains unavailable.
- **Missing or old CLI** — a missing `origin`, or one without `pr diff --patch`, `api`,
  and `pr thread`, produces an actionable Origin-specific error and never falls back to `gh`.
- **Git transport** — fetch/push uses the system helper/GCM for HTTPS or SSH keys; an
  Origin remote never injects `gh auth git-credential`.

## Native OAuth sign-in (GL-139)

Verify with a registered OAuth app (see `docs/provider-oauth-setup.md`); the
polling/PKCE state machines and identity parsing are also covered by unit tests
against a mock HTTP transport, so most of this is checkable without a real app.

- **GitLab device flow** — Settings → Accounts → GitLab → Sign in with OAuth
  shows a user code, opens the verification page, ticks the checklist, and lands
  signed in; a subsequent fetch/push on that remote authenticates via the keychain
  bridge (`oauth2` username).
- **Bitbucket PKCE loopback** — the authorize page opens, approval redirects back
  to the loopback, and sign-in completes (`x-token-auth` username).
- **Transport activation** — after OAuth sign-in from Settings → Accounts, a
  fetch/push (or clone) on any remote for that host authenticates via the keychain
  token with no per-remote binding: transport resolves `providerToken` by host
  (`transportAuthForRemote` / the clone flow look the token up by credentialHost).
  The keychain account also shows in Settings → Accounts with its own sign-out.
- **Unconfigured host** — with no client id set, the OAuth button is hidden and the
  PAT form is offered; setting a per-host client id in Settings enables it.
- **Cancellation** — Cancel (or closing the dialog) stops polling / drops the
  loopback listener and discards the codes; no account is added.
- **Secrets** — the access token, device code, PKCE verifier, and authorization
  code never appear in logs, errors, the frontend, or the returned metadata.
- **Sign-out** — provider sign-out deletes the keychain token by the resolved
  provider account id (not the sentinel username).

## Known limitations

- **OAuth access-token lifetime.** GitLab/Bitbucket OAuth access tokens are
  short-lived; on expiry git auth fails and the user re-runs OAuth sign-in (or uses
  a PAT). Refresh-token rotation is future work (GL-139 follow-up).
- **One OAuth account per host at a time.** OAuth accounts on a host share the
  sentinel git username (`oauth2` / `x-token-auth`), so GitLane keeps **one** OAuth
  account per host: re-signing in on the same host as a different account replaces
  the previous one (its keychain token is deleted first — no orphan). Multiple
  hosts and PAT accounts are unaffected. Simultaneous OAuth accounts on the same
  host are not supported.
- **Self-managed OAuth on a non-standard port.** The keychain token is keyed by
  the OAuth host you configure; transport looks it up by the remote's exact
  credential authority (with port). If those differ (e.g. you configure
  `gitlab.example.com` but the remote is `gitlab.example.com:8443`), sign-in can
  succeed while fetch/push don't find the token — configure the OAuth host exactly
  as it appears in your remote URLs. Port-canonicalization is a GL-139 follow-up;
  `gitlab.com` / `bitbucket.org` are unaffected.
- **glab authenticates as its own account.** glab is single-account and
  host-scoped, so for a GitLab remote whose URL embeds a *different* username and
  has no matching keychain token, transport authenticates as the glab account, not
  the URL username. Store a keychain token (or use a bare URL) to pin a specific
  identity.

- **HTTPS only for the keychain path.** The `providerToken` bridge is scoped to
  `https://` remotes. Plain `http://` remotes fall through to the user's Git
  credential helper (sending a token over cleartext is unsafe by design).
- **Same-user local trust.** The `GIT_ASKPASS` helper reads the keychain from a
  child of the signed GitLane binary, so a local same-user process that can exec
  GitLane with the right env could read a token — inherent to the
  GIT_ASKPASS + OS-keychain pattern; hardening to a parent-brokered socket is
  future work.
- **Azure multi-org on the keychain path** keys by host + username; two Azure
  orgs that share both would collide. Use the credential-helper path (org-scoped)
  when that applies.

## Sign-out vs. forget (must stay distinct)

- **Provider sign-out** (`delete_provider_token`) removes only GitLane's own
  keychain token; the user's Git-helper credentials are untouched.
- **Forget saved HTTPS credential** (`reject_https_credential` →
  `git credential reject`) erases only what the user's Git credential helper
  stored; GitLane's keychain token is untouched.
- Neither touches unrelated CLI credentials (`gh` / `glab` / `az` sessions).

## Diagnostics to confirm

- Missing credential helper / GCM → actionable message, not a silent failure.
- Expired / revoked token → surfaces as an auth failure the user can fix.
- Wrong account / host mismatch → blocked before the operation.
- Unsupported PR provider → precise "PRs unavailable" copy, transport still works.
- **Redaction** — every surfaced `git`/`gh` error scrubs URL-embedded
  credentials (`user:token@host` → `user:***@host`). No token/password appears in
  toasts, logs, or IPC responses.

## Automated coverage (keep green)

Commands: `bunx tsc --noEmit`, `bun run lint`, `bun run test`,
`(cd src-tauri && cargo test)`, `bun run build`.

- **Classification** — `forge.rs` (`classify_host`, all supported forges + codeberg) and
  `src/lib/remotes.test.ts` (`detectRemoteUrl` incl. gitea/forgejo, `azureOrg`,
  `forgeAuthProviderFor`, `credentialScopePath`).
- **Auth-ref resolution** — `git/transport_auth.rs` (`TransportCredential` for
  gh / providerToken / helper, host mismatch, custom port, multi-host same login)
  and `src/store/providerToken.test.ts` (transport selection per provider,
  sign-out reverts to helper).
- **Credential host/path preservation** — `git/credentials.rs`
  (`credential_input` host/path/secret round-trip incl. Azure org path).
- **Bridge end-to-end** — `git/credential_bridge.rs` (a real `git fetch`
  authenticates with the askpass-provided token).
- **Redaction** — `git/redact.rs` (userinfo password scrubbing, multiple URLs,
  scp-style SSH left intact).
- **Secret handling** — `secrets.rs` (keychain round-trip, isolation, control-char
  rejection); provider-token IPC shapes carry no token.
- **Native OAuth (GL-139)** — `git/oauth/` (device polling state machine incl.
  slow_down / expiry / denied / cancel against a mock transport; PKCE RFC 7636
  challenge + state-mismatch + redirect parse; GitLab/Bitbucket identity parsing;
  endpoint/host validation; client-id shape) and, on the TS side,
  `overlays/provider-oauth/*.test.tsx` (device + PKCE dialog runs) and the
  `providerToken.test.ts` OAuth binding/sign-out case.
