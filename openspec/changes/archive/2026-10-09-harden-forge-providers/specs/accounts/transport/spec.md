# Spec Delta

## ADDED Requirements

### Requirement: The provider-token credential broker answers every well-formed request

When git asks GitLane's askpass helper for a stored provider token, the broker SHALL answer
every well-formed request, on every supported platform and whatever the timing of the
helper's writes.

#### Scenario: Helper writes its request after the broker accepted the connection
- **WHEN** on macOS the askpass child connects and its request bytes arrive a few milliseconds after the broker's first read
- **THEN** the broker waits within its read deadline and returns the token, and the git operation authenticates

#### Scenario: A slow helper past the deadline
- **WHEN** the request is not complete within the connection deadline
- **THEN** the broker closes the connection without answering, as today
