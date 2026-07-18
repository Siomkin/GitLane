# Security Policy

## Supported Versions

Security fixes are released for the newest GitLane version only. Before
reporting a vulnerability, reproduce it on the latest published stable or beta
build. Older builds may still be affected after a fix ships.

| Version | Security updates |
| --- | --- |
| Latest stable release | Yes |
| Latest beta release | Yes, until superseded |
| Older releases | No |

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting form for this repository:

<https://github.com/Siomkin/GitLane/security/advisories/new>

Include the affected version or commit, operating system, prerequisites,
reproduction steps, impact, and whether credentials or private repository data
may have been exposed. Remove live tokens, private keys, repository contents,
and other secrets from screenshots and logs. If a credential may have escaped,
revoke or rotate it immediately instead of waiting for triage.

The maintainer will acknowledge the report privately, validate the impact, and
coordinate a fix and disclosure. Please keep the report confidential until a
fixed release or an agreed disclosure date.

## Security Boundaries

GitLane is a local desktop Git client. Repository contents, Git configuration,
remote URLs, provider responses, pull-request text, and persisted application
metadata are untrusted input. The Tauri webview is not a credential store and
receives only the native capabilities required by the current UI.

### Provider credentials

- GitHub authentication is owned by the GitHub CLI (`gh`). GitLane asks `gh`
  for a token only immediately before an authenticated operation, validates the
  selected account and host, and does not persist that token.
- GitLab and Bitbucket provider tokens saved by GitLane live in the
  operating-system keychain. The Rust backend brokers a credential to one Git
  command; provider tokens are not returned to the webview or placed in Git
  command-line arguments. Other HTTPS credentials use the configured Git
  credential helper rather than GitLane-owned storage.
- Native OAuth device codes and access tokens remain in the Rust backend. The
  webview may receive display-safe progress such as the user code and
  verification URL, but never the device code or access token.
- `localStorage` contains non-secret account locators and UI preferences only.
  Persisted account metadata is runtime-validated before entering application
  state. Tokens, refresh tokens, passwords, OAuth device codes, and private keys
  must never be written there or to logs, crash reports, or serialized Tauri
  state.
- Repository/account host mismatches fail before authenticated operations.
  Writes must not silently fall back to a different provider or account.

### Updates and installers

In-app update packages are verified by Tauri against the public updater key in
the application. The corresponding private updater key is available only to the
release workflow; it is separate from platform code signing.

Fresh macOS and Windows downloads are not currently notarized or Authenticode
signed. Those operating systems therefore show an unknown-developer or
unknown-publisher warning on first install. Follow only the install guidance in
the repository README and download releases from this repository's GitHub
Releases page. An updater `.sig` file authenticates in-app updates; it is not a
standalone signature users can use to establish trust in an initial installer.

## Scope

Reports are especially useful for credential disclosure, command or argument
injection, repository path traversal or symlink escape, unsafe updater/release
behavior, permission-boundary bypasses, and cross-repository or cross-account
state confusion.

Ordinary product bugs without a confidentiality, integrity, or availability
impact belong in the public issue tracker. Social engineering, denial of
service that requires overwhelming third-party infrastructure, and findings
that assume an attacker already controls the user's operating-system account
are generally outside this policy unless they cross another documented trust
boundary.
