# Proposal

No Jira issue. Mostly frontend, plus one Rust change: a new error code in the classifier. No new IPC command. It builds on `credential-save-diagnostics` (PR #530) and branches from it.

## Why

After PR #530, a GitHub token can be saved and checked. Two problems remain:

- **A permission failure reads like Git noise.** A token that works but lacks a permission makes GitHub answer `403`, with `Permission to Siomkin/GitLane.git denied to Siomkin`. The backend already classifies this as `forbidden` (`src-tauri/src/git/write/classify.rs`). The frontend has no copy for that code (`friendlyRemoteFailure` in `src/lib/gitError.ts`), so the user sees Git's raw text. Nothing tells them the cause: a fine-grained token with Contents set to Read only.
- **The Connect GitHub screen puts every method on one page.** GitHub CLI, personal access token, Git Credential Manager and SSH all render as stacked cards (`GithubConnect.tsx`). Each card has its own fields and links, and nothing explains what a method is, where its credential comes from, or which token settings to pick. In the field, a user put an account password into the Git Credential Manager form. They then created a fine-grained token without write access and could fetch but not push.

## What Changes

- **A permission failure gets its own message.** `forbidden` on a GitHub remote names the cause: authentication worked, but the token or account may not do this. It names the fix for the method in use: Contents: Read and write for a fine-grained token, the `repo` scope for a classic one, and repository access for `gh` or an SSH key. A push refused this way offers "Fix authentication…" like a missing credential does.
- **"No credential" and "rejected credential" become different messages.** Today both read "credentials are missing or invalid":
  - `credentialsMissing` (Git's `could not read Password … terminal prompts disabled`) means no saved credential reached GitHub at all. In the field, the user's credential helper didn't answer, so the token never left the computer. The message says that, and for GitHub it offers a GitLane token, which doesn't depend on the helper.
  - Git's `Authentication failed` (HTTP 401) means GitHub received a credential and rejected it. It has no code today and shows as raw Git text. A new `credentialsRejected` code in `classify.rs` gets copy that names the likely causes: an expired or revoked token, or a fine-grained token limited to another owner's repositories.
- **The post-save check catches a read-only token.** The check runs `git ls-remote`, which only needs read access, so a token that can't push passes it. The success message for a GitHub token therefore reminds the user that pushing needs Contents: Read and write. It doesn't test pushing: probing write access would need a real push.
- **The Connect screen shows one method at a time.** A method switch at the top (GitHub CLI · Access token · SSH key) shows only the chosen method's fields and guidance. Each method's panel has three parts:
  - **What it is and what it covers.** Fetch, pull and push, and whether pull requests work.
  - **Where to get the credential.** A direct link, and for GitHub Enterprise Server hosts that host's own page.
  - **What to pick.** For a token: a fine-grained token's resource owner, its repository access and Contents: Read and write; or a classic token's `repo` scope.

  The recommended method opens first. Opened from "Fix authentication…", the token method opens first, as today.
- **Every other provider's Connect screen uses the same layout.** GitLab, Bitbucket, Azure DevOps and Cursor Origin show the same method switch and panels: the provider's CLI when it has one (opened first), then Access token and SSH key. Without a CLI, as on Bitbucket, Access token opens first. The CLI's signed-in, not-installed and not-signed-in states, the "connected" line and the provider's docs links keep their wording.
- **One Access token tab, two places to store it.** A personal access token and a Git Credential Manager token are the same token; only where it is kept differs. So the two tabs become one, "Access token", with a "Store in" choice in its last step: GitLane, in the system keychain (recommended), or the user's own Git credential helper, shared with Git in the terminal. The keychain choice exists where GitLane can own the transport token: GitHub, GitLab and Bitbucket. Azure DevOps, Cursor Origin, Gitea and Forgejo get the helper only, with one line saying why. The form asks for a token, never an account password, and links the provider's token page (GitLab's on a self-managed host too) or its docs.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `accounts/transport` (`openspec/specs/accounts/transport/`): adds requirements for:
  - the `forbidden` message on GitHub remotes;
  - telling a missing credential apart from a rejected one;
  - the reminder about write access after saving a token;
  - the one-method-at-a-time Connect screen with its per-method guidance;
  - the same layout for every other provider;
  - one Access token method whose storage, keychain or credential helper, is the user's choice.

## Non-goals

- **No new authentication engine and no change to how storage resolves.** The keychain token, the helper path, `gh` and SSH work as in PR #530. GitLab and Bitbucket keychain tokens already drive transport (GL-132); this change only offers them on the Connect screen, through the same save, check and rollback as GitHub's.
- **No keychain token for providers GitLane can't own one for.** Azure DevOps, Cursor Origin, Gitea and Forgejo keep the helper only.
- **No probe of write access.** No dry-run push.
- **No restyling of the rest of Settings > Accounts.** Only the Connect views and the error copy change.

## Risks

- **Secrets, auth and IPC.** No new command, and none of them carries a new secret. The token still goes only through `save_provider_token` (or `approve_https_credential` on the helper fallback), once, from the form's transient field. The new guidance is static text and links. `forbidden` copy is built from the error code and the remote name, never from token values. Git's own output, shown under Details, stays redacted by the backend.
- **Discoverability.** Hiding methods behind a switch could hide SSH or `gh` from someone who wants them. Every method stays one click away, with the recommended one first.

## Impact

- Rust: `src-tauri/src/git/write/classify.rs` gains `credentialsRejected` for `Authentication failed`, with a classifier test. The error text stays redacted, as before.
- Frontend:
  - `src/components/chrome/settings/accounts-panel/provider-connect/`: `GithubConnect.tsx` is split per method. The shared switch and panel frame move to `methods/`; the other providers' `ForgeConnect.tsx` is rebuilt on them under `forge/`. `MethodCard.tsx` and the stacked cards are removed. `GithubTokenForm.tsx` becomes the provider-parameterised `KeychainTokenForm.tsx`; `credential-entry/` is reused. The shared `methods/AccessTokenMethod.tsx` holds the token tab's three steps and the "Store in" choice.
  - `src/store/accounts/credentials.ts`: `saveGithubToken` is generalised into `saveTransportToken(provider, …)`, with `saveGithubToken` kept as its GitHub alias.
  - `src/lib/gitError.ts`: `forbidden` copy.
  - `src/lib/forgeHelp.ts`: token-page links and permission guidance per host.
  - `src/store/ui/toasts.ts`: the "Fix authentication…" action also for `forbidden`.
- Existing module to copy: the panel follows `GithubTokenForm.tsx` and `CredentialSaveError.tsx` (inline outcome, no toasts inside the Settings modal). The switch follows the segmented controls already used in Settings.
- Visual design: made with Claude Design and linked from `design.md`.
