# Spec Delta

## ADDED Requirements

### Requirement: Credential-helper git runs are insulated like every other git run

The git subprocesses GitLane starts to save, check or forget an HTTPS credential SHALL run
without inherited provider-token environment variables and under the pinned message
locale, like every other git subprocess.

#### Scenario: GitLane launched from a shell that exports a provider token
- **WHEN** `GH_TOKEN` is set in GitLane's environment and the user saves an HTTPS credential for a host whose helper is `!gh auth git-credential`
- **THEN** the post-save `git credential fill` check does not see `GH_TOKEN`, and succeeds only with the credential just saved
