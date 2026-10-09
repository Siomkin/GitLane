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

### Requirement: Review threads show an anchored diff snippet when one is available

GitLane SHALL display a read-only diff snippet on a review-thread card when the selected provider supplies an anchored hunk for that thread. The snippet MUST reflect the provider-supplied hunk and MUST NOT invite the user to edit it. GitLane MUST NOT reconstruct a replacement hunk from local git when the provider omitted one.

#### Scenario: Thread has an anchored hunk
- **WHEN** a selected pull request has a review thread and the provider supplied an anchored hunk for it
- **THEN** the thread card shows that snippet along with the existing file, line, and comments

#### Scenario: Thread has no hunk
- **WHEN** a selected pull request has a review thread and the provider did not supply an anchored hunk
- **THEN** GitLane still shows the thread card and omits the snippet

#### Scenario: Snippet is not editable
- **WHEN** a thread card shows a diff snippet
- **THEN** the snippet is read-only and offers no control that edits the hunk or submits review text

### Requirement: A provider-capped diff says it is truncated

When a provider's diff read stops at GitLane's page cap, the returned files SHALL be marked
truncated, so the Diff tab and the detail file counts never present a partial diff as
complete.

#### Scenario: GitLab merge request with more files than the cap
- **WHEN** a GitLab MR's diff fills every allowed page
- **THEN** the files carry the truncated flag, as a Bitbucket pull request in the same situation does

### Requirement: Provider web links keep the remote's scheme and port

Links GitLane builds to a repository's pages on its forge SHALL use the scheme and port of
the repository's HTTP(S) remote.

#### Scenario: Self-hosted GitLab on a custom port
- **WHEN** the remote is `https://gitlab.example.com:8443/team/app.git`
- **THEN** the "merge requests" link opens `https://gitlab.example.com:8443/team/app/-/merge_requests`

#### Scenario: SSH remote
- **WHEN** the remote is `git@gitlab.example.com:team/app.git`
- **THEN** links use `https://gitlab.example.com/team/app`

### Requirement: The review-thread author badge identifies the PR author by login

A review-thread comment SHALL show the "Author" badge when its author's login equals the pull request author's login, whatever either display name is.

#### Scenario: PR author with a display name replies in a thread
- **WHEN** the PR author is `{ login: "jdoe", name: "Jane Doe" }` and a thread comment's author has only the login `jdoe`
- **THEN** that comment shows the Author badge

#### Scenario: Another user shares the author's display name
- **WHEN** a different login has the same display name as the PR author
- **THEN** that user's comment does not show the Author badge

### Requirement: Rendered Markdown keeps ordered-list numbering

Markdown rendered in pull-request bodies, previews and AI-action output SHALL show ordered lists with their numbers and unordered lists with bullets.

#### Scenario: Numbered test plan in a PR body
- **WHEN** a PR body contains `1. build` and `2. run tests`
- **THEN** the items render numbered 1 and 2, not as bullets
