# Spec Delta

## ADDED Requirements

### Requirement: A git push remote cannot be interpreted as an option

Every `git push` remote operand, whether it arrives over IPC or is read from repository configuration (`branch.<name>.pushRemote`, `remote.pushDefault`, `branch.<name>.remote`), MUST be rejected before `git push` is spawned when it starts with `-`.

#### Scenario: Branch push remote configured with a leading dash
- **WHEN** a repository's `branch.<name>.pushRemote` is `--receive-pack=evil` and the user pushes that branch
- **THEN** GitLane refuses the operation before invoking `git push`

#### Scenario: Default push remote configured with a leading dash
- **WHEN** a repository's `remote.pushDefault` is `--exec=evil` and the user pushes a branch with no remote of its own
- **THEN** GitLane refuses the operation before invoking `git push`

### Requirement: Remote-agent GitHub credential helper validates host authorities

Before the remote agent builds an inline `git` credential helper for the server's own GitHub CLI login, GitLane MUST validate the remote's host and the GitHub CLI account's host with the same host-authority rules the desktop applies, so no quote, whitespace, or shell metacharacter can reach the helper command. A host that fails validation MUST yield no GitHub CLI credential for that remote.

#### Scenario: Malformed remote host on a remote SSH repository
- **WHEN** the remote agent resolves credentials for a remote whose host contains a quote, whitespace, or a shell metacharacter
- **THEN** GitLane builds no inline `gh` credential helper for that host

#### Scenario: Malformed GitHub CLI account host on the server
- **WHEN** the server's GitHub CLI reports an account whose host contains a quote, whitespace, or a shell metacharacter
- **THEN** GitLane builds no inline `gh` credential helper from that account
