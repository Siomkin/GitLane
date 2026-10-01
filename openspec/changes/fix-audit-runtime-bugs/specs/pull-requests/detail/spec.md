# Spec Delta

## ADDED Requirements

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
