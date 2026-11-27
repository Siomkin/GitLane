# Delta Specification: history/write-ops

## MODIFIED Requirements

### Requirement: A diverged rewritten branch can be published with force-with-lease from the push chrome

When the current local branch has an upstream, is diverged, and is not covered by the mismatched-upstream namesake publish rule, GitLane MUST offer leased force-push (`--force-with-lease`: preview, confirm, push) in the push chrome and keep regular Push disabled. GitLane MUST NOT force-push without confirmation and MUST abort if the remote moved. Branch-menu force-push MAY remain outside that rule and MUST be hidden when covered by it.

#### Scenario: Action bar offers force-push when the current branch is diverged
- **WHEN** the current branch tracks an upstream not covered by the mismatched-upstream namesake publish rule and is diverged from it (ahead and behind)
- **THEN** regular Push is disabled and a Force push control is enabled in the same push chrome

#### Scenario: Confirmed force-push updates the remote feature after a rebase
- **WHEN** the user has rebased local `feature` onto `develop` so it is diverged from `origin/feature`, and they confirm Force push
- **THEN** GitLane force-pushes `feature` with `--force-with-lease` and the graph no longer shows a stale `origin/feature` at the pre-rebase commit

#### Scenario: Force-push is not automatic after rebase
- **WHEN** a rebase of a published branch completes and the branch is now diverged from its upstream
- **THEN** GitLane does not push until the user confirms Force push

#### Scenario: Lease aborts when the remote moved
- **WHEN** the user confirms Force push and the upstream commit no longer matches the lease captured at preview
- **THEN** the remote branch is not overwritten and the user is told the lease failed

## ADDED Requirements

### Requirement: Pushing a branch that tracks a differently-named remote publishes its own name

When a local branch tracks a differently-named remote branch, has no explicit push remote overriding that upstream remote, and has no remote-tracking ref with its own name on that target remote, GitLane SHALL route Push (toolbar, branch menu, and Commit & Push) to the Publish prompt pre-filled with `<target-remote>/<local-branch>` across `upToDate`, `ahead`, `behind`, and `diverged`, and MUST hide leased force-push from both the toolbar and the branch menu.

#### Scenario: Local feature branch is ahead of a differently-named remote base

- **WHEN** `feat/mcp-apps-subscriptions` tracks `origin/develop` with no overriding push remote, is 1 commit ahead of `origin/develop`, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** toolbar Push and branch-menu Push are enabled and open the Publish prompt pre-filled with `origin/feat/mcp-apps-subscriptions`
- **AND** GitLane does not push `feat/mcp-apps-subscriptions` directly onto `origin/develop`

#### Scenario: Commit and Push on a branch tracking a differently-named remote base

- **WHEN** the user runs Commit & Push on `feat/mcp-apps-subscriptions` while it tracks `origin/develop` and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** GitLane opens the Publish prompt pre-filled with `origin/feat/mcp-apps-subscriptions` instead of pushing directly to `origin/develop`

#### Scenario: Diverged branch tracking a differently-named remote hides force-push in toolbar and branch menu

- **WHEN** `feat/mcp-apps-subscriptions` is checked out, tracks `origin/develop` with no overriding push remote, is both ahead of and behind `origin/develop`, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** neither the toolbar nor the branch context menu offers Force push
- **AND** Push opens the Publish prompt pre-filled with `origin/feat/mcp-apps-subscriptions`

#### Scenario: Local feature branch is behind a differently-named remote base

- **WHEN** `feat/mcp-apps-subscriptions` tracks `origin/develop`, is behind `origin/develop`, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** Push is enabled and opens the Publish prompt pre-filled with `origin/feat/mcp-apps-subscriptions`

#### Scenario: Triangular fork workflow preserves explicit push remote

- **WHEN** `feat/mcp-apps-subscriptions` tracks `upstream/develop`, has `branch.feat/mcp-apps-subscriptions.pushRemote` (or `remote.pushDefault`) set to `origin`, and is ahead of `upstream/develop`
- **THEN** Push does not open a publish prompt targeting `upstream/feat/mcp-apps-subscriptions` and does not rewrite the branch's upstream tracking
- **AND** ordinary Push targets `origin/feat/mcp-apps-subscriptions`

#### Scenario: Namesake on an unrelated remote does not bypass the guard

- **WHEN** `feat/mcp-apps-subscriptions` tracks `origin/develop`, is ahead of `origin/develop`, `backup/feat/mcp-apps-subscriptions` exists on another remote, and `origin/feat/mcp-apps-subscriptions` does not exist
- **THEN** Push still opens the Publish prompt pre-filled with `origin/feat/mcp-apps-subscriptions` instead of pushing onto `origin/develop`

#### Scenario: Namesake already exists on the target remote

- **WHEN** `feat/mcp-apps-subscriptions` tracks `origin/develop` and `origin/feat/mcp-apps-subscriptions` already exists
- **THEN** GitLane does not hijack Push into a namesake publish prompt and keeps standard upstream sync behavior
