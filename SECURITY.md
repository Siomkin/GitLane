# Security Policy

## Authentication Boundary

GitLane uses the GitHub CLI (`gh`) as the default GitHub provider. `gh` owns
credential storage, SSO, multi-account state, and enterprise host configuration.

GitLane may persist frontend-safe account metadata only:

```json
{
  "provider": "gh",
  "host": "github.com",
  "accountId": "583231",
  "login": "octocat"
}
```

GitHub tokens, OAuth device codes, refresh tokens, and provider secrets must not
be written to Zustand, localStorage, logs, crash reports, serialized Tauri
state, or IPC payloads. The Rust backend resolves `gh` tokens immediately before
use, passes them to child processes via `GH_TOKEN`, and drops them after the
operation.

Repository/account host mismatches must fail before authenticated operations.
Writes must not silently fall back to another provider or account identity.

Non-GitHub provider auth status is informational only. GitLane may probe local
CLIs such as `glab`, `az`, or `tea`, but those probes must not request, persist,
or return access tokens. Bitbucket app-password setup remains outside GitLane
storage until a secure provider implementation exists.

## Reporting a Vulnerability

Report security issues privately to the project owner. Include reproduction
steps, affected versions or commits, and whether credential material may have
been exposed.
