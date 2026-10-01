# Spec Delta

## ADDED Requirements

### Requirement: Every create-PR entry point is offered on Origin repositories

Every surface that offers to create a pull request SHALL offer it for a Cursor Origin repository whenever it would offer it for GitHub. This includes the PR list, the branch context menu, and the toolbar. Settings and help text MUST describe the Origin pull-request features that ship. They MUST NOT say that creation is unavailable.

#### Scenario: Branch menu on an Origin repository
- **WHEN** the user opens the context menu of a local branch in a Cursor Origin repository
- **THEN** "Open a pull request…" is listed

#### Scenario: Accounts page for a signed-in Origin CLI
- **WHEN** the user views Settings → Accounts with the origin CLI signed in
- **THEN** the provider row does not say "Sign-in only" and its notes do not say that creating Origin PRs is unavailable
