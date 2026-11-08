## Purpose

GitLane can hold a provider credential for a host on the user's behalf — captured by native sign-in or pasted as a token — and hand it to git and forge operations without it ever leaving the backend. This capability fixes what capturing and storing that credential guarantees.

## Requirements

### Requirement: A native browser sign-in completes despite unrelated local requests

While a browser-redirect sign-in is waiting for the provider's callback, a request to the local callback listener that does not carry the sign-in's one-time state value MUST NOT end, fail, or otherwise change the outcome of the sign-in. Only a callback carrying the matching state MUST be accepted as the provider's answer, whether it reports success or a provider error. The sign-in still ends on the user's cancel or on its deadline.

#### Scenario: Stray error request before the real callback

- **WHEN** a Bitbucket sign-in is waiting and a local client sends a callback request with `error=denied` and no state, and the browser then delivers the real callback with the authorization code and matching state
- **THEN** the sign-in continues, accepts the real callback, and completes

#### Scenario: Provider denial with matching state

- **WHEN** the user declines authorization in the browser and the provider redirects with `error=access_denied` and the matching state
- **THEN** the sign-in ends with an authorization-failed message

#### Scenario: Forged code with wrong state

- **WHEN** a local client sends a callback carrying a code and a state value that does not match
- **THEN** the code is discarded, no token exchange is attempted, and the sign-in keeps waiting

#### Scenario: Deadline still applies

- **WHEN** no callback with the matching state arrives before the sign-in deadline
- **THEN** the sign-in ends with a timeout message

### Requirement: A stored credential is never replaced or orphaned by a different account card

A credential GitLane stores for one account card on a host MUST remain retrievable and deletable through that card until the user signs that card out. Completing a sign-in for another card on the same host — including a native sign-in whose provider-reported identifier happens to equal another card's typed login — MUST NOT replace, delete, or orphan the first card's credential.

#### Scenario: Pasted token and native sign-in with colliding identifiers

- **WHEN** the user has saved a pasted token for a GitLab host under login `42`, and then completes native sign-in on that host as an account whose provider id is `42`
- **THEN** both cards remain, fetch/push with the pasted-token card still authenticates with the pasted token, and signing out the pasted-token card leaves the native sign-in usable

#### Scenario: Re-sign-in of the same native account

- **WHEN** the user completes native sign-in on a host for an account already signed in natively
- **THEN** that account's stored credential is replaced with the new one and no other card is affected

#### Scenario: Pasted login that imitates a native locator

- **WHEN** the user pastes a token and types a login that uses GitLane's reserved native-sign-in namespace
- **THEN** GitLane refuses to save it with a message asking for the account username

### Requirement: The provider-token credential broker answers every well-formed request

When git asks GitLane's askpass helper for a stored provider token, the broker SHALL answer
every well-formed request, on every supported platform and whatever the timing of the
helper's writes.

#### Scenario: Helper writes its request after the broker accepted the connection
- **WHEN** on macOS the askpass child connects and its request bytes arrive a few milliseconds after the broker's first read
- **THEN** the broker waits within its read deadline and returns the token, and the git operation authenticates

#### Scenario: A slow helper past the deadline
- **WHEN** the request is not complete within the connection deadline
- **THEN** the broker closes the connection without answering, as today

### Requirement: Git transport on a GitHub remote authenticates as the bound gh account

When a GitHub HTTPS remote is bound to a signed-in `gh` account, clone, fetch, pull, and push on that remote MUST authenticate as that account, whichever account `gh` currently has active on the host. GitLane MUST NOT change the user's global `gh` state (for example with `gh auth switch`) to achieve this, and MUST NOT authenticate as a different account when the bound one cannot supply a credential.

#### Scenario: Bound account is not gh's active account

- **WHEN** `gh` is signed in to github.com as `alice` (active) and `bob` (inactive), the repository's `origin` is bound to `bob`, and the user fetches or pushes
- **THEN** the operation authenticates as `bob` and succeeds without a sign-in prompt or auth-error toast

#### Scenario: Bound account is gh's active account

- **WHEN** the remote is bound to the account `gh` has active and the user pulls
- **THEN** the operation authenticates as that account, as before this change

#### Scenario: Global gh state is left alone

- **WHEN** any transport operation above completes, whether it succeeds or fails
- **THEN** `gh auth status` reports the same active account per host as before the operation

#### Scenario: Bound account has no usable token

- **WHEN** the remote is bound to `bob` but `gh` holds no token for `bob` on that host, and `alice` is active
- **THEN** the operation fails with an authentication error and does not authenticate as `alice`

#### Scenario: GitHub Enterprise Server remote

- **WHEN** a GHES remote is bound to an inactive `gh` account on that GHES host and the user pushes
- **THEN** the push authenticates as the bound GHES account

### Requirement: The bound gh account's token stays out of git and hook environments

The token used to authenticate a GitHub transport operation MUST NOT be present in the environment of the git process or of any hook git runs, and MUST NOT cross IPC or be persisted by GitLane.

#### Scenario: Pre-push hook environment

- **WHEN** a repository has a pre-push hook that records its environment and the user pushes to a GitHub remote bound to a `gh` account
- **THEN** the recorded environment contains no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, or `GITHUB_ENTERPRISE_TOKEN`

### Requirement: A malformed gh account binding is refused before any git command runs

A `gh` account binding whose login is not a plausible GitHub login MUST be rejected with a readable error before git is invoked, and no helper command built from it may run. A plausible login is 1–100 characters of ASCII letters, digits, `-`, `_`, or `.`, and does not start with `-`. This covers github.com, Enterprise Managed User (`name_shortcode`), and GHES logins.

#### Scenario: Enterprise Managed User login

- **WHEN** the remote is bound to the `gh` account `octocat_acme` and the user fetches
- **THEN** the binding is accepted and the fetch authenticates as `octocat_acme`

#### Scenario: Login containing shell metacharacters

- **WHEN** a stored binding's login is `bob'; rm -rf ~; '` and the user fetches
- **THEN** the fetch is refused with an error asking the user to choose the account again, and git is not run

### Requirement: A refused permission on a GitHub remote says authentication worked

When fetch, pull, push or the post-save check on a GitHub remote fails with HTTP 403, or with Git's `Permission to <repo> denied to <login>`, GitLane MUST say that the credential authenticated but lacks permission for this operation on this repository. When Git names the login and the repository, the message MUST name them. It MUST NOT be the "credentials missing" copy, MUST NOT contain a token or password, and MUST offer "Fix authentication…".

#### Scenario: A read-only token is refused on push

- **GIVEN** a GitHub HTTPS remote that authenticates with a token whose Contents permission is Read only
- **WHEN** a push fails with `Permission to Siomkin/GitLane.git denied to Siomkin` and a 403
- **THEN** GitLane says the token authenticated as `Siomkin` but may not push to `Siomkin/GitLane`
- **AND** offers "Fix authentication…"

### Requirement: A refused permission names the fix for the remote's transport

For a refused permission on an HTTPS GitHub remote, the message MUST name the token settings to change and that the account needs write access. For a fine-grained token, the settings are Contents: Read and write, plus a resource owner and repository access that include the repository. For a classic token, the `repo` scope. For an SSH remote, the message MUST say that the key's account, or a deploy key, needs write access, and MUST NOT mention tokens.

#### Scenario: HTTPS names the token settings

- **GIVEN** a push refused with a 403 on `https://github.com/Siomkin/GitLane`
- **THEN** the message names Contents: Read and write and the `repo` scope

#### Scenario: SSH names the key's access

- **GIVEN** a push refused with `ERROR: Permission to Siomkin/GitLane.git denied to Siomkin` over SSH
- **THEN** the message says the key's account needs write access and does not mention tokens

### Requirement: A credential that never reached the server reads as missing

When Git reports that it could not read a username or password because prompts are disabled, GitLane MUST say that no saved credential reached the server. For a GitHub HTTPS remote that uses the credential helper, it MUST offer to save the token as a GitLane token instead.

#### Scenario: The helper never answered

- **GIVEN** a GitHub HTTPS remote whose credential helper returns nothing
- **WHEN** Git fails with `could not read Password for 'https://siomkin@github.com': terminal prompts disabled`
- **THEN** GitLane says no saved credential reached GitHub
- **AND** offers "Use a GitLane token instead"

### Requirement: A credential the server rejected reads as rejected

When Git reports `Authentication failed` or `Invalid username or token`, GitLane MUST say that the server rejected the credential. For GitHub it MUST name the likely causes: an expired or revoked token, or a fine-grained token whose resource owner does not own the repository. The message MUST NOT contain a token or password, and MUST offer "Fix authentication…".

#### Scenario: GitHub rejects a revoked token

- **GIVEN** a GitHub remote whose saved token was revoked
- **WHEN** Git fails with `Authentication failed for 'https://github.com/Siomkin/GitLane/'`
- **THEN** GitLane says GitHub rejected the token, and names expiry, revocation and the resource owner as causes

### Requirement: A saved GitHub token's success says what the check did not cover

When a GitHub token is saved and the post-save check accepts it, the success message MUST say that the check proved read access only. It MUST also say that pushing needs Contents: Read and write on a fine-grained token, or the `repo` scope on a classic one. GitLane MUST NOT push to probe write access.

#### Scenario: A token passes the read check

- **GIVEN** the user saves a GitHub token and `origin` accepts it
- **WHEN** the check result is shown
- **THEN** it says `origin` accepted the token for reading, and what pushing additionally needs

### Requirement: The Connect GitHub screen shows one connection method at a time

The Connect GitHub screen MUST let the user choose one of GitHub CLI, Access token and SSH key. It MUST then show only the chosen method's fields, actions and guidance, with every method reachable in one step. GitHub CLI MUST be chosen when the screen opens normally. Opened from "Fix authentication…", Access token MUST be chosen and no terminal commands shown.

#### Scenario: Choosing a method hides the others' fields

- **GIVEN** the Connect GitHub screen with GitHub CLI chosen
- **WHEN** the user chooses Access token
- **THEN** the token fields and guidance are shown, and no CLI sign-in or SSH fields

#### Scenario: Fix authentication opens on the token method

- **WHEN** the user clicks "Fix authentication…" on a credential or permission error
- **THEN** the screen opens with Access token chosen and no terminal commands

### Requirement: Every provider's Connect screen shows one method at a time

The Connect screen of every provider other than GitHub MUST offer, behind the same method switch, its CLI when it has one, then Access token and SSH key, and show only the chosen method's fields and guidance. The CLI MUST be chosen first when the provider has one; otherwise Access token MUST be chosen first. Each panel MUST say what the method covers, including whether pull requests work in GitLane for that provider.

#### Scenario: GitLab opens on its CLI

- **GIVEN** GitLab with `glab` available
- **WHEN** the user opens Connect GitLab
- **THEN** the switch offers GitLab CLI, Access token and SSH key, with GitLab CLI chosen and no credential fields shown
- **WHEN** the user chooses Access token
- **THEN** the token fields are shown, and the CLI's login command is not

#### Scenario: Bitbucket has no CLI

- **WHEN** the user opens Connect Bitbucket
- **THEN** the switch offers Access token and SSH key, with Access token chosen

### Requirement: Each connection method says what it covers and where its credential comes from

Each method's panel MUST say what the method is, which of fetch, pull, push and pull requests it enables, and where to get its credential, with a direct link: the provider's token page where GitLane knows one, else the provider's docs. For a GitHub Enterprise Server or self-managed GitLab host, the links MUST point to that host.

#### Scenario: An Enterprise Server host gets its own links

- **GIVEN** the open repository's GitHub remote is on `github.corp.example`
- **WHEN** the user opens the Access token panel
- **THEN** the token-page link points to `github.corp.example`

#### Scenario: A self-managed GitLab host gets its own token page

- **GIVEN** the open repository's GitLab remote is on `gitlab.example.com`
- **WHEN** the user opens the Access token panel on Connect GitLab
- **THEN** the token-page link points to `https://gitlab.example.com/-/user_settings/personal_access_tokens`

### Requirement: The token method suggests token settings without prescribing them

The Access token panel MUST present token settings as suggestions the user decides on. For GitHub: a fine-grained token's resource owner, repository access and Contents, or a classic token's `repo` scope. For GitLab: `read_repository`, `write_repository`, and `api` only for merge requests without glab. Elsewhere: read and write access to repositories. It MUST NOT show the open repository's or owner's name. A refused permission MUST highlight GitHub's Contents.

#### Scenario: The token panel lists the settings

- **WHEN** the user chooses Access token for github.com
- **THEN** the panel suggests resource owner, repository access, Contents and the `repo` scope, says these are suggestions
- **AND** it shows neither the open repository's name nor its owner's name

#### Scenario: GitLab's panel lists its scopes

- **WHEN** the user chooses Access token on Connect GitLab with a GitLab repository open
- **THEN** the panel suggests `read_repository` and `write_repository`, and `api` only for merge requests
- **AND** it shows neither the open repository's name nor its group's name

#### Scenario: A refused push highlights write access

- **GIVEN** a push was refused for permission
- **WHEN** the user opens the screen from "Fix authentication…"
- **THEN** Contents: Read and write is highlighted

### Requirement: The Access token method stores the token where the user chooses

The Access token method MUST store the token in GitLane's keychain or the user's credential helper, by the user's choice, keychain recommended where supported: GitHub, GitLab and Bitbucket. Elsewhere it MUST offer the helper only and say why. It MUST ask for a token, never an account password. The token MUST go once to `save_provider_token` or `approve_https_credential`, and "Stored by" MUST follow the choice.

#### Scenario: GitLab defaults to the keychain

- **GIVEN** the user chooses Access token on Connect GitLab with a GitLab HTTPS remote open
- **THEN** "Store in" offers GitLane's keychain, chosen and recommended, and the user's credential helper
- **WHEN** the user saves a token
- **THEN** GitLane stores it as a GitLab keychain token and checks the remote with that token

#### Scenario: Choosing the helper hands the token to Git

- **GIVEN** the Access token panel with "My Git credential helper" chosen
- **WHEN** the user saves a token
- **THEN** GitLane hands it to `git credential approve` and stores no keychain token
- **AND** "Stored by" reads "Your helper"

#### Scenario: Azure DevOps has the helper only

- **WHEN** the user chooses Access token on Connect Azure DevOps
- **THEN** no storage choice is shown, the helper form is, and one line says GitLane keeps its own tokens for GitHub, GitLab and Bitbucket only

### Requirement: A pasted GitHub token authenticates git despite a broken helper chain

The user MUST be able to paste a GitHub personal access token in Settings > Accounts and have GitLane store it as its own token. Fetch, pull and push on that host's HTTPS remotes MUST then authenticate with it, whatever the user's configured credential helpers return. A remote bound to a signed-in `gh` account keeps using that account.

#### Scenario: Stale helper entry ahead of the user's helper

- **WHEN** the system git config has a helper that returns a stale `x-access-token` credential for every github.com request, and the user saves a valid token in GitLane's GitHub token form
- **THEN** a fetch, pull or push from a github.com HTTPS remote in GitLane authenticates with the saved token and succeeds, with no terminal step

#### Scenario: Remote URL with a username in different case

- **WHEN** the remote URL is `https://Siomkin@github.com/…` and the user saved the token under `siomkin`
- **THEN** the fetch authenticates with the saved token

#### Scenario: Remote bound to a gh account

- **WHEN** a GitHub remote is bound to a signed-in `gh` account and a GitLane token is also saved for github.com
- **THEN** that remote still authenticates as the bound `gh` account

#### Scenario: GitHub Enterprise Server

- **WHEN** the user saves a token for a GitHub Enterprise Server host
- **THEN** that host's HTTPS remotes authenticate with it, and github.com remotes are unaffected

#### Scenario: Removing the token

- **WHEN** the user removes the saved GitHub token in Settings > Accounts
- **THEN** GitLane deletes it from the OS keychain, and that host's remotes go back to the user's own credential helpers

### Requirement: Saving falls back to the credential helper when the keychain is unavailable

If the OS keychain cannot store the token, the form MUST say the system has no available secure storage, keep the token in its field, and offer to save it with the user's Git credential helper instead. The user's helpers MUST NOT be changed without that choice.

#### Scenario: Linux without a Secret Service

- **WHEN** the user saves a GitHub token on Linux where no Secret Service is running
- **THEN** the form says the keychain is unavailable and offers "Save with Git credential helper instead", and choosing it runs the helper save and its checks

#### Scenario: No keychain and no helper

- **WHEN** the keychain is unavailable and no Git credential helper is configured
- **THEN** the form says neither secure storage nor a credential helper is available, and suggests SSH as the alternative, without showing any terminal command

### Requirement: A failed HTTPS credential save is reported in the form that started it

When saving a credential from Settings > Accounts fails, in the token form, the helper form or a remote's credential card, the reason MUST appear inline in that form, using the backend's own message. A generic "not saved" text alone is not enough. The typed token MUST stay in its field. Success MUST clear the token and any earlier error.

#### Scenario: Helper form save fails

- **WHEN** the user saves a token in the Git Credential Manager / helper form and the backend rejects the save
- **THEN** the form shows that rejection's message, and the token field still holds the token

#### Scenario: Remote card save fails

- **WHEN** the user saves a token on a remote's HTTPS credential card and the backend rejects the save
- **THEN** the card shows the backend's message in place of "Credential was not saved. Check the error and try again."

#### Scenario: Retry succeeds

- **WHEN** a save that failed is retried and succeeds
- **THEN** the inline error is gone and the token field is cleared

### Requirement: The helper read-back names the username a helper returned instead

After a helper save, GitLane asks Git to read the credential back. If a helper returns a credential for a different username, the save MUST fail with an `auth` error that names the returned username and says Git matches usernames exactly, case included. The returned username MUST be provided as structured data, not only in the message.

#### Scenario: Another helper shadows the saved credential

- **WHEN** the user saves a token for `siomkin` on `github.com` through the helper, and the read-back returns a credential for `x-access-token`
- **THEN** the save fails, the message names `x-access-token` as the username Git returned instead of `siomkin`, and the error carries `x-access-token` as data

#### Scenario: Helper returns nothing

- **WHEN** the read-back returns no credential at all
- **THEN** the save fails with a message that the credential helper did not return the saved credential, and the error carries no returned username

### Requirement: The returned secret never leaves the read-back

The read-back MUST NOT log, return, persist, or put into any error or event the secret the helper returned, or the secret the user saved. Only the returned username may cross IPC.

#### Scenario: Error payload of a mismatched read-back

- **WHEN** a read-back returns a different username together with a password
- **THEN** no field of the rejection contains that password or the saved token

### Requirement: One click forgets the credential that shadowed a helper save

When a helper save fails because a different username came back, the form MUST offer to forget that username's saved credential on the same host and path, after a confirmation. GitLane MUST then save and verify again, with the token still in the field. The card's existing Forget action MUST still forget only the remote's own username.

#### Scenario: Forget the stale entry and save again

- **WHEN** a helper save failed because `x-access-token` came back, and the user confirms "Forget @x-access-token and save again"
- **THEN** GitLane asks Git to forget the `github.com` credential for `x-access-token` only, then saves and verifies the typed token again

#### Scenario: Shadowing persists

- **WHEN** the forget succeeds but the next read-back still returns a different username
- **THEN** the form shows the new mismatch with its own forget offer, plus the GitLane-token option where the keychain is available, and GitLane does not retry by itself

#### Scenario: Card Forget is unchanged

- **WHEN** the user presses Forget on a remote's credential card with no failed save shown
- **THEN** only the credential for the remote URL's username is forgotten

### Requirement: Helper saves use the username the remote URL already has

On the helper path, the saved credential's username and the remote URL's username MUST be identical. A remote's credential card MUST write both from the same value. The host-level helper form MUST save under the spelling an open repo's HTTPS remote URL uses for that host when the typed username differs from it only in case, and MUST say so.

#### Scenario: Case-only difference in the helper form

- **WHEN** the open repository's `origin` is `https://Siomkin@github.com/…` and the user saves `siomkin` in the helper form
- **THEN** the credential is saved for `Siomkin`, and the form says it used the remote's spelling

#### Scenario: Remote card

- **WHEN** the user saves a credential on a remote's card with the username `Siomkin`
- **THEN** the remote URL username and the saved credential's username are both `Siomkin`

### Requirement: A saved credential is checked against the remote right away

After a successful save, GitLane MUST check each HTTPS remote of the open repository on that host with the same transport auth a fetch would use, and report the result inline, per remote. If every checked remote rejects a GitLane-owned token as an authentication failure, GitLane MUST remove that token again. With no matching open remote, the form MUST say the credential was saved but not yet checked.

#### Scenario: Token works

- **WHEN** the user saves a valid token and the open repository's `origin` is on that host
- **THEN** the form reports that `origin` accepted it

#### Scenario: Token rejected

- **WHEN** the user saves a GitLane token and the check of `origin` fails as an authentication error
- **THEN** the form shows the remote's rejection, the token is no longer stored, and the token field still holds it for correction

#### Scenario: Network failure during the check

- **WHEN** the check cannot reach the remote
- **THEN** the form says the credential was saved but could not be checked, and keeps it

#### Scenario: No repository open

- **WHEN** the user saves a token with no repository open, or none of its remotes is on that host
- **THEN** the form says the credential was saved and will be used on the next fetch, without claiming it was verified

### Requirement: Fix authentication leads to a working GitHub remote without a terminal

For a GitHub authentication failure, the toast's "Fix authentication…" action MUST open Settings > Accounts on a GitHub token flow: paste the token, save, check. The username is prefilled from the failing repository's remote URL when it has one. Nothing in this flow MUST show or ask for a terminal command.

#### Scenario: Fetch fails for missing GitHub credentials

- **WHEN** a fetch from a github.com HTTPS remote fails with an authentication error and the user clicks "Fix authentication…"
- **THEN** Settings > Accounts opens on the GitHub token form, and after a valid token is saved the form reports that the remote accepted it

#### Scenario: No terminal instructions

- **WHEN** the GitHub token flow is opened from "Fix authentication…"
- **THEN** it shows no terminal command and no "Prefer the terminal?" disclosure

### Requirement: GitHub credentials are asked for as a personal access token

For a GitHub host, the secret field MUST be labelled as a personal access token (fine-grained or classic), not a password. A "Create a token" link MUST open that host's token settings. The credentials-missing hint for a GitHub remote MUST mention a personal access token.

#### Scenario: GitHub token form

- **WHEN** the user opens a GitHub token or helper form
- **THEN** the secret field reads as a personal access token, and "Create a token" opens GitHub's token settings

#### Scenario: Missing-credentials hint

- **WHEN** a fetch from a github.com HTTPS remote fails as `credentialsMissing`
- **THEN** the hint says GitHub needs a personal access token, not the account password

### Requirement: A github.com secret that does not look like a token gets a soft warning

On github.com only, a secret that does not start with `ghp_`, `github_pat_`, `gho_`, `ghu_`, or `ghs_` MUST show a warning that GitHub does not accept account passwords for Git. The warning MUST NOT disable or block saving. No warning MUST be shown for any other host.

#### Scenario: Password typed for github.com

- **WHEN** the user enters a secret without a known token prefix for `github.com`
- **THEN** a warning appears and Save stays enabled

#### Scenario: GitHub Enterprise Server

- **WHEN** the user enters a secret without a known prefix for a GitHub Enterprise Server host
- **THEN** no prefix warning appears and the secret saves normally

### Requirement: A GitLane-held provider token stays out of hook environments

The value of a provider token stored by GitLane MUST NOT appear in the environment or command line of git or of any hook git runs. Hooks are trusted user code and MAY reach the same credential route git was given.

#### Scenario: Pre-push hook environment in provider-token mode

- **WHEN** a repository has a pre-push hook that records its environment and the user pushes with a GitLane-held provider token
- **THEN** the recorded environment and argument list do not contain the token value

### Requirement: A GitHub remote's account picker offers every account on its host

On a GitHub HTTPS remote, the account picker MUST list each signed-in `gh` account and each GitLane keychain token saved for that remote's host. Each entry MUST show its source, so two accounts with the same login are distinguishable. The picker MUST show the account that git transport will use for the remote. When there is only one possible choice, the picker MUST NOT appear, and the remote MUST show a note saying how it authenticates.

#### Scenario: A gh account and a keychain token share a login

- **WHEN** `gh` is signed in to github.com as `Octocat`, a keychain token is saved for github.com as `octocat`, and the user opens the account picker on a github.com HTTPS remote
- **THEN** the picker lists `@Octocat` marked as GitHub CLI and `@octocat` marked as Keychain token as separate choices

#### Scenario: A token saved for another host

- **WHEN** a keychain token is saved for a GitHub Enterprise host and the user opens the picker on a github.com remote
- **THEN** that token is not listed

#### Scenario: Only a keychain token exists

- **WHEN** a keychain token is saved for the remote's host and no `gh` account matches that host
- **THEN** no picker appears and the remote shows that it authenticates with a token stored in the OS keychain

#### Scenario: SSH remote

- **WHEN** the remote uses SSH and a keychain token is saved for its host
- **THEN** no picker appears and the remote shows that its account is selected by the SSH key

#### Scenario: Repository opened over SSH

- **WHEN** a repository opened over SSH has a GitHub HTTPS remote and this computer has a keychain token for that host
- **THEN** the picker does not list the token and the token is not shown as the account in use

### Requirement: Choosing a keychain token makes the remote authenticate with it

When the user chooses a keychain token in a GitHub remote's account picker, fetch, pull, and push on that remote MUST authenticate with that token, even when a signed-in `gh` account has the same login in any letter case. If the remote is the repository's default remote, pull requests MUST use the same token. The choice MUST NOT change the user's global `gh` state and MUST survive reopening the repository.

#### Scenario: Choosing a token whose login matches a gh account

- **WHEN** `origin` is bound to the `gh` account `Octocat`, a keychain token is saved as `octocat`, and the user chooses the keychain token and pushes
- **THEN** the push authenticates with the keychain token, and `gh auth status` reports the same active account as before

#### Scenario: Another token exists on the host

- **WHEN** a `gh` account and a keychain token share a login, a second keychain token was saved later for that host, and the user chooses the token sharing the login and fetches
- **THEN** the fetch and pull requests use the chosen token, and the picker still shows it

#### Scenario: A token saved after the choice

- **WHEN** a remote uses a keychain token whose login matches a `gh` account and the user saves another token for that host
- **THEN** the remote keeps using the chosen token

#### Scenario: Connecting another gh account

- **WHEN** a remote uses a keychain token and the user connects a new `gh` account from that remote's picker
- **THEN** the remote keeps using the keychain token

#### Scenario: The title bar names the chosen token

- **WHEN** the default GitHub remote uses a keychain token and the user opens the title bar's account card
- **THEN** the card names the token's account and does not say pull requests are off

#### Scenario: Pull requests follow the chosen token

- **WHEN** the user chooses a keychain token on the default remote and opens the pull requests view
- **THEN** pull requests are fetched with that token and the remote's summary shows the token's account

#### Scenario: Choosing a token whose login matches no gh account

- **WHEN** a keychain token is saved as `other`, no `gh` account on that host is named `other`, and the user chooses that token and fetches
- **THEN** the fetch authenticates with that token

#### Scenario: The choice survives reopening

- **WHEN** the user chooses a keychain token, closes the repository, and opens it again
- **THEN** the picker still shows the keychain token as the choice and transport still uses it

#### Scenario: Switching back to the gh account

- **WHEN** a remote uses a keychain token and the user chooses the `gh` account in the picker and pushes
- **THEN** the push authenticates as the `gh` account

#### Scenario: Signing out the chosen token

- **WHEN** a remote uses a keychain token and the user signs that token out in Settings > Accounts, leaving no other token for the host
- **THEN** the remote no longer shows the token as a choice and goes back to the user's own credential helpers

### Requirement: System git credentials is offered only when it would be used

The account picker MUST offer "System git credentials" on a GitHub HTTPS remote only when no keychain token is saved for that remote's host.

#### Scenario: No keychain token for the host

- **WHEN** the remote's host has a matching `gh` account and no keychain token
- **THEN** the picker offers "System git credentials" and the `gh` account

#### Scenario: A keychain token exists for the host

- **WHEN** the remote's host has a matching `gh` account and a keychain token
- **THEN** the picker offers the `gh` account and the keychain token, and does not offer "System git credentials"
