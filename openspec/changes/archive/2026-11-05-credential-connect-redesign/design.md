# Design

Visual design: [Connect GitHub redesign](https://claude.ai/artifact/889XveLQ8wkcUhGbkykUwp), a canvas built on the GitLane design system. It has two boards:
- **Connect GitHub, one method at a time.** Interactive: the method switch works.
- **Credential errors that name the cause.** Static.

## Context

See proposal.md for why. What shapes the approach:

- **Engine.** No new engine work. Errors come from the Git CLI write layer: `run_transport` → `finish` → `classify_failure` in `src-tauri/src/git/write/classify.rs`, redacted before they cross IPC.
  - `forbidden` already exists there, with kind `auth`, so `src/store/ui/toasts.ts` already attaches "Fix authentication…" to it. What's missing is frontend copy: `friendlyRemoteFailure` in `src/lib/gitError.ts` has no case for it and returns Git's raw text.
  - Git's `Authentication failed` (HTTP 401, a rejected credential) has no code at all.
- **`gitError.ts` lives in `lib`.** It sits below `store` in the import order, so it can't ask the accounts store which transport a remote uses. The error text already says enough: a GitHub HTTPS failure names `https://…` and prints `remote: Permission to <repo> denied to <login>`, while an SSH failure prints `ERROR: Permission to <repo> denied to <login>` plus `Could not read from remote repository`.
- **The Connect screen.** `ProviderConnect.tsx` renders `GithubConnect.tsx`, which stacks four `MethodCard`s: the token card (first when `authFailure`), GitHub CLI, Git Credential Manager (`CredentialEntryForm`) and SSH. `GithubTokenForm.tsx` and `credential-entry/` hold the PR #530 save, check and recovery logic; they stay as they are.
- **No shared segmented control.** `GeneralPanel.tsx` has a local theme toggle built from `aria-pressed` buttons. Settings has no tab or segmented primitive in `src/components/ui/`.
- **Stores.** No store changes. The chosen method is local component state; it isn't persisted, because which method fits depends on the moment, for example arriving from "Fix authentication…".

## Goals / Non-Goals

**Goals:**
- Every credential failure on a GitHub remote reads as one of four causes, each with its own fix:
  - no credential reached the server;
  - the credential was rejected;
  - the credential works but lacks permission;
  - the network or host is unreachable.
- The Connect GitHub screen shows one method's fields and guidance at a time, as in the design.
- Every other provider's Connect screen uses the same shell, with the methods it already has.

**Non-Goals:**
- No change to how credentials are stored or resolved (`transportAuth.ts`, `credential_bridge.rs`).
- No write-access probe.
- No keychain token for Azure DevOps, Cursor Origin, Gitea or Forgejo (decision 8).

## Decisions

### 1. `forbidden` copy is built from the error text, not from the store

`friendlyRemoteFailure` gets a `forbidden` case. It parses `Permission to <repo> denied to <login>` from the body, when present, and tells HTTPS from SSH from the remote URL in the body, or from `Could not read from remote repository`, which only SSH prints. For a GitHub host it returns the HTTPS or the SSH copy from the spec. For other hosts it returns a generic "authenticated but not allowed" line.

GitHub's SSH refusal (`ERROR: Permission to <repo> denied to <login>`) prints no 403 and used to classify as `notFoundOrDenied`. `classify.rs`'s `http_forbidden` pattern therefore also matches a `Permission to … denied to` line, so SSH refusals reach this case too.

*Alternative considered:* pass the remote's resolved transport mode into `friendlyGitError` through `FriendlyGitErrorOptions`. Every caller (toasts, onboarding, the checks) would then need the accounts store, and `store/ui` can't import `accounts` (the order is ui < accounts). The text already tells HTTPS from SSH, and the spec only needs that split, so this was rejected.

### 2. A new Rust code, `credentialsRejected`, for `Authentication failed`

`classify.rs` gains a regex, `(?im)^\s*(?:fatal:|remote:).*(?:authentication failed|invalid username or (?:password|token))`, which returns kind `auth`, code `credentialsRejected`. It runs right after `credentialsMissing` and before `remote_not_found_or_denied`. Kind `auth` gives it "Fix authentication…" for free. `gitError.ts` adds the copy, with a GitHub variant that names expiry, revocation and a fine-grained token's resource owner.

`credentialsMissing` copy changes as well. It now says that no saved credential reached the server, instead of "missing or invalid". The phrase "for @user" stays.

*Alternative considered:* detect 401 in the frontend from the text. That was rejected because codes come from the backend classifier (architecture-rules §1, CommandError contract), and a code lets tests pin the mapping.

**Size:** `classify.rs` is 463 lines, and its `mod tests` block (from line 187) is about 275 lines, over the ~150-line threshold in architecture-rules-rust.md §6. The new test goes into `write/classify/tests.rs`, so the tests move there in this change. Production code stays in `classify.rs`. This is a pure move; `bun run sizes` and `cargo test` confirm it.

### 3. The method switch is a shared `SegmentedControl` in `src/components/ui/`

Extract the `aria-pressed` toggle from `GeneralPanel.tsx` into `src/components/ui/SegmentedControl.tsx`, so that `GeneralPanel` and the Connect screen both use it. It renders as a `radiogroup` with `role="radio"` buttons and arrow-key movement, because the user picks one of several options. The visuals match the design system's pill track.

*Alternative considered:* a tab list. Tabs imply panels that keep their own state while you switch between them. Here, switching method throws away the other method's unsaved fields, so a radio group reads truer.

### 4. `GithubConnect.tsx` becomes a container plus one panel per method

```
provider-connect/github/
  GithubConnect.tsx        container: switch + chosen panel, initial method
  methods.ts               pure: method list, initial method (authFailure → "token"), capability rows
  CliMethod.tsx            sign-in, install link, "what happens" steps
  TokenMethod.tsx          capabilities, 1 create (fine-grained / classic links), 2 what to pick, 3 GithubTokenForm
  HelperMethod.tsx         "Advanced" badge, what it is for, CredentialEntryForm (token wording) — merged into the Access token tab, decision 8
  SshMethod.tsx            add key link, switch-remote steps
  CapabilityStrip.tsx      the four "Fetch, pull / Push / Pull requests / Stored by" tiles
```

This follows the folder-module pattern (architecture-rules-react.md §4a), so no file nears the 400-line ceiling. `CapabilityStrip.tsx` and the panel frame later move to `methods/` (decision 7).

**Where the guidance comes from.** "What the token needs" is static copy in `TokenMethod.tsx`, framed as suggestions the user decides on. It names no repository or owner: a private repository's name on screen leaks into screenshots and screen shares, and the generic wording works for every repository the token will serve. The SSH panel's example address is a placeholder (`git@<host>:owner/repo.git`) for the same reason. Links come from `forgeHelp.ts` `tokenHelp(provider, host)`, which gains `fineGrainedUrl`, so GitHub Enterprise Server hosts get their own pages. `openGithubRemote()` is used only for the host.

**The Git Credential Manager panel doesn't list the configured helpers.** `helper_status` (`credentials.rs`) is used only inside `approve_https_credential`, and no command exposes it. Listing the helpers would need a new read command plus its four IPC layers and a `LOCAL_ONLY` classification, which is out of proportion here. The panel explains the method in words. If no helper is configured, the existing `noCredentialHelper` error from a save already points to the token method.

### 5. The post-save success line mentions write access for GitHub only

`RemoteCheckResults` gets an optional `readOnlyNote`. `GithubTokenForm`, and the GitHub path of `TransportCredentialCard`, pass the Contents and `repo` reminder. Other providers are unchanged.

### 6. Opening from "Fix authentication…"

The current `accountsConnectReason: "authFailure"` sets the initial method to `token`. A `forbidden` failure opens the same way. The token panel's step 2 then gets a highlighted "Contents: Read and write" row, driven by the reason. That needs a new reason value: `"permission"`, added next to `"authFailure"` in `src/store/ui/settings.ts`. `toasts.ts` picks it when the error code is `forbidden`.

### 7. One shell for every provider

The other providers get GitHub's layout with the methods `ForgeConnect.tsx` already offered, so the switch, the panel frame and the capability strip move out of `github/` into a shared folder, and each provider family keeps only its configuration and panels:

```
provider-connect/
  methods/                 the shared shell; imports nothing from github/ or forge/
    capabilities.ts        pure: Capability type, the four tiles in order
    CapabilityStrip.tsx    the tiles
    MethodPanel.tsx        title, badge, intro, strip, then the method's steps
    MethodSwitch.tsx       "How do you want to connect?" + SegmentedControl
    index.ts
  github/                  GitHub's configuration: methods.ts + four panels
  forge/                   every other provider
    ForgeConnect.tsx       container: connected line, switch, chosen panel, Refresh / Learn more / notes
    ConnectedBanner.tsx    keychain-token or signed-in CLI line, as before
    methods.ts             pure: CLI first when status.cli, default method, capability tiles
    CliMethod.tsx          signed in / not installed / not signed in, worded as before
    HelperMethod.tsx       GCM and docs links, Bitbucket HTTPS note, CredentialEntryForm — now TokenMethod.tsx, decision 8
    SshMethod.tsx          sshKeyHelp links
```

- **Default method.** The provider's CLI when `status.cli` is set, else Git Credential Manager. That default carries the "Recommended" badge until a CLI is signed in or a keychain token exists, the same rule the old leading card used.
- **Pull requests tile.** `prSupportedFor(status.provider)` decides it, worded like the existing signed-in line: not available in GitLane; via the CLI; or, for a provider without one, needing an API credential.
- **What stays outside the panels.** The connected line (it describes the provider, not a method) sits above the switch; Refresh, Learn more and the provider's notes sit below it, under every method.
- **No repository names.** The panels use generic placeholders only, as on GitHub. The Bitbucket HTTPS example stays `https://username@bitbucket.org/workspace/repo.git`.
- `MethodCard.tsx` and the old stacked `ForgeConnect.tsx` are removed, together with the method glyphs only they used.

### 8. Storage is a choice inside one Access token tab

The Personal access token and Git Credential Manager tabs took the same token and differed only in where it was kept, so the user had to understand storage before choosing a tab. They merge into one tab, "Access token", for every provider: CLI (if any) · Access token · SSH key. Its three steps live once in `methods/AccessTokenMethod.tsx` — create the token (per-provider links), what it needs (per-provider suggestions), paste it — and its last step asks "Store in":

- **GitLane, in your system keychain** (recommended, chosen first). `KeychainTokenForm` (the former `GithubTokenForm`, now taking a provider) calls `saveTransportToken(provider, …)`, the generalised `saveGithubToken`: stage under a fresh keychain id when a token exists, check the open remotes with `providerTokenCheckRef`, delete it when every remote refuses, keep the previous one. Offered where `transportAuthForRemote` picks a keychain token for the host: GitHub, and GitLab and Bitbucket (`supportsProviderTokenAuth`, GL-132; `pickProviderTokenForHost` wins over glab and the helper). For GitLab and Bitbucket that token also serves GitLane's REST pull requests, so the pull-request tile says so.
- **My Git credential helper.** The existing `CredentialEntryForm` → `approve_https_credential`, with its shadowed-entry recovery and no-helper error. For a provider without keychain support it is the only option, shown without the radio and with one line saying why.

"Stored by" follows the choice. The choice is local component state, like the method. Flipping it swaps the form, so a pasted but unsaved token is dropped; the choice sits above the fields so it is made first. `TransportCredentialCard`'s "Try this token for pull requests too" stays as it was; the Connect helper path never stored a PR token, and the keychain path now covers pull requests on its own.

GitLab's token page is `https://<host>/-/user_settings/personal_access_tokens` (`tokenHelp`), so a self-managed host gets its own. GitLane knows no stable token page for Bitbucket (Atlassian account settings) or the other providers, so those link the provider's docs (`ForgeAuthStatus.docsUrl`).

*Alternative considered:* keep two tabs and explain the difference in each. That leaves the user to pick a storage before they know they are picking one, which is how a password ended up in the helper form.

## IPC

No new command, and no change to any command's arguments or result. `CommandError.code` gains the value `credentialsRejected`:
- Rust: `classify.rs`.
- TS: the `CommandError` code union in `src/lib/api/git/types/error.ts`, if codes are typed there; otherwise only the `gitError.ts` switch.

The four-layer checklist doesn't apply beyond that code.

## Risks / Trade-offs

- [A GitHub Enterprise Server remote on a custom host (`github.corp.example`) isn't recognized as GitHub by `providerForHost`, which must stay in step with the Rust side] → Such a remote isn't prefilled. Its links work once the user types the host in the token form, and `*.github.com` hosts are prefilled. Recognizing custom hosts is a follow-up.

- [The Git or GitHub wording changes, and parsing misses the login and repository] → The copy falls back to a version without the names. The backend code (`forbidden`, `credentialsRejected`) still picks the right message, and Details shows the raw text.
- [`Invalid username or token` also appears for a username typo with a valid token] → GitHub ignores the username when the secret is a token, so in practice a rejection means the token itself. The copy names token causes first and stays accurate.
- [Hiding methods behind a switch] → The switch always shows every method's label (three on GitHub, two or three elsewhere). The recommended method opens first, and the token method opens from a failure.
- [The moved classify tests could hide a change] → It's a pure move; the test count before and after is listed in the commit.

## Migration Plan

None. Frontend copy and layout plus one additive error code. Rolling back is a revert.
