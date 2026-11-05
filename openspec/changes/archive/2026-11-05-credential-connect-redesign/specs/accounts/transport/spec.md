## ADDED Requirements

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
