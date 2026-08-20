## MODIFIED Requirements

### Requirement: Users can work with existing Origin review threads

GitLane SHALL list existing Origin review threads and SHALL allow users to resolve and reopen those threads. GitLane MUST NOT allow users to reply to a thread or start a new line-anchored thread in the app and SHALL direct comment activity to the Origin pull request in the user's browser.

#### Scenario: List threads
- **WHEN** the selected Origin pull request has review threads
- **THEN** GitLane shows those threads with their resolution state

#### Scenario: Reply to a thread
- **WHEN** the user wants to reply to an existing Origin review thread
- **THEN** GitLane offers to open the Origin pull request in the default browser instead of showing an in-app reply editor

#### Scenario: Resolve and reopen a thread
- **WHEN** the user resolves or reopens an existing Origin review thread
- **THEN** Origin records the new resolution state and GitLane reflects it

#### Scenario: New inline thread is unavailable
- **WHEN** the user would start a new diff-anchored thread on Origin
- **THEN** GitLane omits that action and provides the external Origin pull-request action without invoking GitHub
