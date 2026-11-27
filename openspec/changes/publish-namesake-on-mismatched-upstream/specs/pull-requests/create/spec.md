# Delta Specification: pull-requests/create

## ADDED Requirements

### Requirement: Auto-publishing a PR head matches the pull request target repository

When opening a pull request from a head branch that is unpublished or covered by the mismatched-upstream namesake publish rule, GitLane MUST publish only to a configured remote whose effective push URL matches the resolved PR repository. If no remote matches or the branch publishes to a different repository (unsupported cross-repository head), GitLane MUST disable creation, MUST NOT publish or submit a bare head, and MUST explain why inline.

#### Scenario: Mismatched-upstream branch on the PR target repository auto-publishes its own name

- **WHEN** the resolved PR repository matches remote `origin`, `feat/mcp-apps-subscriptions` tracks `origin/develop`, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** the dialog indicates it will publish to `origin/feat/mcp-apps-subscriptions`
- **AND** submitting publishes `feat/mcp-apps-subscriptions` to `origin/feat/mcp-apps-subscriptions` before creating the pull request

#### Scenario: Branch targets a different remote than the resolved PR repository

- **WHEN** the resolved PR repository matches remote `upstream`, `feat/mcp-apps-subscriptions` tracks `origin/develop` (or pushes to `origin` in a fork workflow), and `upstream/feat/mcp-apps-subscriptions` does not exist
- **THEN** the dialog disables pull request creation and explains that cross-repository pull requests are not supported
- **AND** GitLane does not publish to `origin` or `upstream` and does not submit a pull request

#### Scenario: Resolved PR repository has no matching configured remote

- **WHEN** the resolved PR repository (for example via `gh repo set-default`) does not match any configured remote's push URL and the head branch needs publishing
- **THEN** the dialog disables pull request creation and explains that cross-repository pull requests are not supported
- **AND** GitLane does not publish the branch or submit a pull request

#### Scenario: The effective push destination changed after the dialog resolved the repository

- **WHEN** Git resolves an effective push URL outside the repository shown by the dialog
- **THEN** GitLane stops before publishing and explains the destination mismatch, including when HTTP(S) endpoints differ by effective port

#### Scenario: Publishing changes the repository selected by the forge

- **WHEN** publishing succeeds but the forge subsequently resolves a different repository from the one verified for publishing
- **THEN** GitLane does not submit the pull request and explains that the repository changed
- **AND** the open dialog retains the originally verified repository for subsequent attempts
