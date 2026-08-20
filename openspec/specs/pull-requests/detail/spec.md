# pull-requests/detail Specification

## Purpose

Defines how GitLane presents pull-request discussion without duplicating each provider's comment editor and review conversation workflow.

## Requirements

### Requirement: Pull-request discussion is read-only in GitLane

GitLane SHALL display available pull-request discussion comments and review threads but MUST NOT offer controls that submit authored text. This prohibition includes top-level comments, review-thread replies, request-changes reviews, comment-only reviews, and text attached to a review.

#### Scenario: Read existing discussion
- **WHEN** a selected pull request has discussion comments or review threads
- **THEN** GitLane shows the available discussion without a comment or reply editor

#### Scenario: No discussion exists
- **WHEN** a selected pull request has no discussion comments or review threads
- **THEN** GitLane shows a read-only empty state without inviting the user to compose text

#### Scenario: Review action would submit text
- **WHEN** a review action requires or includes user-authored text
- **THEN** GitLane does not offer that action in the app

### Requirement: Discussion continues on the provider site

GitLane SHALL provide a visible action that opens the selected pull request on its provider so the user can add or reply to comments there. The action MUST use the pull request's provider-supplied URL and MUST surface missing, invalid, or rejected URLs instead of failing silently.

#### Scenario: Open provider discussion
- **WHEN** the user chooses the external-provider action for a pull request with a valid provider URL
- **THEN** GitLane asks the operating system to open that pull request in the default browser

#### Scenario: Provider URL is unavailable
- **WHEN** the user chooses the external-provider action and the pull request has no valid provider URL
- **THEN** GitLane shows an actionable error and does not attempt to construct a replacement URL

### Requirement: Non-text review actions remain available

GitLane SHALL retain supported review actions that do not author comment text, including bodyless approval and changing an existing thread's resolution state. These actions MUST remain subject to the selected provider's existing capabilities.

#### Scenario: Approve without a comment
- **WHEN** the selected provider supports approval and the user approves an open pull request
- **THEN** GitLane submits the approval without a comment body and refreshes the pull request

#### Scenario: Change thread resolution
- **WHEN** the selected provider supports thread resolution and the user resolves or reopens an existing review thread
- **THEN** GitLane records and refreshes the thread state without submitting comment text
