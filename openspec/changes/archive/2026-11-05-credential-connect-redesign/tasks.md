# Tasks

## 1. Rust: classify a rejected credential

- [x] 1.1 Move the `mod tests` block of `src-tauri/src/git/write/classify.rs` into `src-tauri/src/git/write/classify/tests.rs` unchanged (architecture-rules-rust.md §6). Record the number of tests before and after.
- [x] 1.2 Add a `credentials_rejected` regex to `classify.rs` matching `fatal:`/`remote:` lines with `Authentication failed` or `Invalid username or password|token`. Return kind `Auth`, code `credentialsRejected`, checked after `credentialsMissing` and before `remote_not_found_or_denied`.
- [x] 1.3 Add classifier tests in `classify/tests.rs`:
  - GitHub's 401 output maps to `credentialsRejected`;
  - `terminal prompts disabled` still maps to `credentialsMissing`;
  - `Permission to X denied` with a 403 still maps to `forbidden`.

## 2. Types and copy

- [x] 2.1 Add `credentialsRejected` to the documented `auth` codes in `src/lib/api/git/types/error.ts`.
- [x] 2.2 In `src/lib/gitError.ts`, add a `forbidden` case. Parse `Permission to <repo> denied to <login>` when present, and tell HTTPS from SSH from the body. Return the GitHub HTTPS copy (token settings plus account access), the GitHub SSH copy (key's account, deploy key) or a generic line for other hosts.
- [x] 2.3 In `src/lib/gitError.ts`, add a `credentialsRejected` case: for GitHub, name expiry, revocation and a fine-grained token's resource owner; a generic line elsewhere.
- [x] 2.4 Reword `credentialsMissing` to say that no saved credential reached the server, keeping the `for @user` part and the existing hints.
- [x] 2.5 Add `gitError.test.ts` cases for each new or changed message:
  - the exact `Permission to Siomkin/GitLane.git denied to Siomkin` + 403 body;
  - an SSH variant;
  - a 401 body;
  - a body without names (the fallback copy);
  - every message contains no `ghp_` or `github_pat_` text taken from the body.

## 3. Shared segmented control

- [x] 3.1 Extract the `aria-pressed` toggle from `src/components/chrome/settings/GeneralPanel.tsx` into `src/components/ui/SegmentedControl.tsx`: a `radiogroup` of `role="radio"` buttons with arrow-key movement, styled as today.
- [x] 3.2 Switch `GeneralPanel.tsx` to it with no visual change. Add `SegmentedControl.test.tsx` covering selection, arrow keys and `aria-checked`.

## 4. Connect GitHub, one method at a time

- [x] 4.1 Create `provider-connect/github/methods.ts`: the method list, `initialMethod(reason)` (`authFailure` or `permission` → `token`, else `cli`), and the four capability rows per method. Add `methods.test.ts`.
- [x] 4.2 Add `CapabilityStrip.tsx`: the four tiles for fetch/pull, push, pull requests and "stored by".
- [x] 4.3 Add `TokenMethod.tsx`:
  - step 1, fine-grained and classic links from `tokenHelp`;
  - step 2, what to pick: resource owner, repository access, Contents: Read and write; classic `repo`, optional `workflow`; filled with the open remote's owner and repository from `openGithubRemote()` when present; the Contents row is highlighted for the `permission` reason;
  - step 3, `GithubTokenForm`.
- [x] 4.4 Extend `tokenHelp` in `src/lib/forgeHelp.ts` with `fineGrainedUrl` (github.com and Enterprise Server hosts), plus a `forgeHelp.test.ts` case for an Enterprise Server host.
- [x] 4.5 Add `CliMethod.tsx`: sign-in, install link and the "what happens" steps. It shows `gh auth login` only when not opened from a failure.
- [x] 4.6 Add `HelperMethod.tsx`: an "Advanced" badge, what the method is for, and `CredentialEntryForm` with token wording.
- [x] 4.7 Add `SshMethod.tsx`: the add-key and how-to links, and the switch-remote steps (pointing to Repository settings › Remotes).
- [x] 4.8 Rewrite `GithubConnect.tsx` as the container under `provider-connect/github/`: `SegmentedControl` plus the chosen panel, and the initial method from the connect reason. Update `ProviderConnect.tsx` and `index.ts` imports. `MethodCard.tsx` stays for `ForgeConnect.tsx`.

## 5. Post-save note and the permission entry point

- [x] 5.1 Add an optional `readOnlyNote` to `RemoteCheckResults`. Pass the Contents/`repo` reminder from `GithubTokenForm` and from the GitHub path of `TransportCredentialCard`.
- [x] 5.2 Add `"permission"` to `AccountsConnectReason` in `src/store/ui/settings.ts`. In `src/store/ui/toasts.ts`, open Accounts with `"permission"` when the error code is `forbidden`, and with `"authFailure"` otherwise.

## 6. Tests

- [x] 6.1 In `CredentialSaveFlows.test.tsx`, or a new `github/GithubConnect.test.tsx`, cover:
  - choosing a method shows only its fields;
  - "Fix authentication…" (`authFailure`) opens on Personal access token with no terminal command;
  - the `permission` reason highlights Contents: Read and write;
  - the token panel lists resource owner, repository access, Contents and `repo`;
  - an Enterprise Server remote gets that host's token link;
  - the success line carries the write-access reminder.
- [x] 6.2 Add a `toasts` test: a `forbidden` error opens Accounts with the `permission` reason, and a `credentialsRejected` error carries "Fix authentication…".
- [x] 6.3 Keep the coverage ratchet green. Add tests where `bun run coverage` reports a drop, rather than accepting it.

## 7. Verify

- [x] 7.1 `bun check`, `bun run lint`, `bun run test`, `bun run build`, `bun run sizes`, `bun run cycles`, `bun run coverage`.
- [x] 7.2 `(cd src-tauri && cargo fmt --all -- --check)`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo clippy --all-targets --no-default-features --features agent -- -D warnings`, `cargo test --lib`.
- [x] 7.3 `bun run tauri dev` with a fine-grained token that has Contents: Read only (checked in the dev app by the user, 2026-11-05):
  - saving shows the read-only reminder;
  - a push shows the permission copy, and "Fix authentication…" opens on the token method with Contents highlighted;
  - each method in the switch shows only its own fields.

## 8. Other providers, one method at a time

- [x] 8.1 Move `MethodPanel.tsx` and `CapabilityStrip.tsx` from `provider-connect/github/` to a shared `provider-connect/methods/`, with `capabilities.ts` (the `Capability` type and the four tiles in order), `MethodSwitch.tsx` (the "How do you want to connect?" label plus `SegmentedControl`) and an `index.ts`. `MethodPanel` takes its capability rows as a prop; `github/` passes `CAPABILITIES[method]`.
- [x] 8.2 Add `provider-connect/forge/methods.ts`: the switch options (the provider's CLI first when `status.cli` is set, then Git Credential Manager and SSH key), the default method (CLI, else Git Credential Manager) and the capability tiles, with the pull-request tile from `prSupportedFor`. Add `methods.test.ts`.
- [x] 8.3 Add `forge/CliMethod.tsx`, `forge/HelperMethod.tsx` and `forge/SshMethod.tsx` from the old `CliBody`, `CredentialHelperBody` and `SshBody`, keeping their states and wording: signed in (with the account), not installed (Install button), not signed in (login command); GCM and docs links, the Bitbucket HTTPS URL note and `CredentialEntryForm`; `sshKeyHelp` links.
- [x] 8.4 Add `forge/ConnectedBanner.tsx` (the keychain-token and signed-in lines, unchanged) and rebuild `forge/ForgeConnect.tsx` as the container: banner, switch, chosen panel, then Refresh, Learn more and the provider's notes. The default method keeps the "Recommended" badge until something is connected. Point `ProviderConnect.tsx` at it, keyed by provider.
- [x] 8.5 Remove the old `provider-connect/ForgeConnect.tsx`, `MethodCard.tsx` and the `DownloadIcon`/`LockIcon` glyphs only they used.
- [x] 8.6 Tests: `forge/ForgeConnect.test.tsx` covers GitLab with `glab` opening on the CLI and switching to show only the chosen method's fields, Bitbucket opening on Git Credential Manager, and the CLI's signed-in, not-installed and not-signed-in messages plus the connected lines. Update `AccountsPanel.test.tsx` for Azure DevOps opening on its CLI.
- [x] 8.7 `bun check`, `bun run lint`, `bun run test:coverage`, `bun run coverage`, `bun run build`, `bun run sizes`, `bun run cycles`, and `openspec validate credential-connect-redesign --strict`.

## 9. One Access token tab, storage by choice

- [x] 9.1 Generalise `saveGithubToken` in `src/store/accounts/credentials.ts` into `saveTransportToken(provider, host, login, token)`, keeping `saveGithubToken` as its GitHub alias and its tests. Add `credentialSave.test.ts` cases: a GitLab save calls `save_provider_token` with `gitlab`, checks the remote with a `providerToken` ref, and transport then resolves to it; a refused Bitbucket token is deleted.
- [x] 9.2 Add `openProviderRemote(provider)` to `credentialChecks.ts`, and GitLab's personal access tokens page (host-aware) to `tokenHelp` in `forgeHelp.ts`, with tests.
- [x] 9.3 Rename `GithubTokenForm.tsx` to `KeychainTokenForm.tsx`, taking a provider (GitHub default): host and username from the provider's open remote or `defaultTransportUsername`, GitHub-only read-only note.
- [x] 9.4 Add `methods/AccessTokenMethod.tsx`: the three steps, the "Store in" choice (keychain recommended) where supported, else one line saying the helper stores it, and the helper's GCM link.
- [x] 9.5 GitHub: `methods.ts` lists GitHub CLI · Access token · SSH key, `githubCapabilities(method, storage)`; `TokenMethod.tsx` uses the shell. Forge: `methods.ts` lists CLI? · Access token · SSH key, opens on Access token without a CLI, pull-request tile counts a GitLab/Bitbucket keychain token; new `forge/TokenMethod.tsx` with GitLab, Bitbucket and generic suggestions. Remove both `HelperMethod.tsx`.
- [x] 9.6 Tests: `GithubConnect.test.tsx`, `ForgeConnect.test.tsx`, both `methods.test.ts`, `AccountsPanel.test.tsx`, `CredentialSaveFlows.test.tsx` for three tabs, the storage default, a GitLab keychain save and check, a helper save, Azure helper-only, "Stored by" following the choice, and no repository names.
- [x] 9.7 Update the spec requirements, `design.md` (decision 8) and `proposal.md`; `openspec validate credential-connect-redesign --strict`.
- [x] 9.8 `bun check`, `bun run lint`, `bun run test:coverage`, `bun run coverage`, `bun run build`, `bun run sizes`, `bun run cycles`.
