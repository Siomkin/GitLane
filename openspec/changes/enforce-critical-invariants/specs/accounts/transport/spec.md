# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: The bound gh account's token never reaches git or its hooks`
- TO: `### Requirement: The bound gh account's token stays out of git and hook environments`

## ADDED Requirements

### Requirement: A GitLane-held provider token stays out of hook environments

The value of a provider token stored by GitLane MUST NOT appear in the environment or command line of git or of any hook git runs. Hooks are trusted user code and MAY reach the same credential route git was given.

#### Scenario: Pre-push hook environment in provider-token mode

- **WHEN** a repository has a pre-push hook that records its environment and the user pushes with a GitLane-held provider token
- **THEN** the recorded environment and argument list do not contain the token value
