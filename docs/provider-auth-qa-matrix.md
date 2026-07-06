# Provider authentication & git-transport QA matrix (GL-131 / GL-138)

This is the verification checklist for GitLane's provider authentication and git
transport parity. It maps each supported forge to the git operations that must
work and the auth-specific edge cases to check. Automated coverage is noted per
area; the rest is a manual pass to run before shipping auth changes.

## Support level per provider

PR/API is GitHub-only for now. **Git transport (clone/fetch/pull/push/…) must
work for every provider** through one of three auth paths:

- **gh** — GitHub's CLI owns the token; injected inline as `gh auth
  git-credential` per invocation (`Gh` transport credential).
- **keychain** — a GitLane-owned provider token in the OS keychain, fed to git
  via the `GIT_ASKPASS` bridge (`providerToken` transport credential, GL-132).
- **helper** — the user's own Git credential helper / GCM (`credentialHelper` /
  system), optionally seeded once via `git credential approve`.

| Provider | Classified by | Transport auth | PR/API | In-app sign-in | Sign-out |
| --- | --- | --- | --- | --- | --- |
| GitHub | `github.com` / `*.github.com` (exact) | gh | ✅ | `gh auth login --web` | `gh auth logout` |
| GitLab | host contains `gitlab` | keychain **or** helper (glab optional) | ❌ (MR API pending) | keychain PAT; or `glab auth login` | keychain token; or `glab auth logout` |
| Bitbucket | `bitbucket.org` / contains `bitbucket` | keychain **or** helper | ❌ | keychain PAT; or saved credential | keychain token; or forget credential |
| Azure Repos | `dev.azure.com` / `ssh.dev.azure.com` / `*.visualstudio.com` | keychain **or** helper/GCM | ❌ | keychain PAT; or GCM; org-scoped | keychain token; or `az logout` |
| Gitea | host contains `gitea` | keychain **or** helper | ❌ | keychain PAT; or saved credential | keychain token; or forget credential |
| Forgejo | `codeberg.org` / contains `forgejo` | keychain **or** helper | ❌ | keychain PAT; or saved credential | keychain token; or forget credential |
| Unknown HTTPS | none (`other`) | helper only | ❌ | saved credential (username + token) | forget credential |
| SSH (any) | scheme | SSH key (no HTTPS binding) | n/a | SSH key | remove key |

Native OAuth device flows for GitLab/Bitbucket are **not** implemented: they
require a registered OAuth application (client id) per provider/host, which is a
product/infra decision. The in-app **PAT-into-keychain** path is the supported
first-class sign-in until then; Azure's "OAuth" is delegated to GCM where
present. Native OAuth is tracked as **GL-139** (child of GL-131); see also
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

- **Classification** — `forge.rs` (`classify_host`, all six forges + codeberg) and
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
