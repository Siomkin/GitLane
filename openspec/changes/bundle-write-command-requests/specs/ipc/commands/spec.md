## ADDED Requirements

### Requirement: Multi-field write commands carry their inputs as one request object

A write command that takes more than six inputs beyond the repository locator MUST accept them as a single request object with named fields rather than as positional arguments. The request object MUST be validated at the API seam so that a missing required field is rejected with a structured error before the command runs, and optional expectations (expected branch, expected head, expected operation state) MUST be expressible as absent fields with the same meaning as "no expectation".

#### Scenario: commit with a pinned identity and an expected head
- **WHEN** the frontend commits with a summary, description, amend flag, pinned author name and email, and an expected branch and head
- **THEN** the command receives every field by name, the commit is created only if the expected head still matches, and the resulting commit carries the pinned identity

#### Scenario: request missing a required field
- **WHEN** a squash request omits the parent commit id
- **THEN** the call is rejected at the API seam with a structured error naming the field, and no git write runs

#### Scenario: expectation left out
- **WHEN** a reset request carries neither an expected head branch nor an expected head id
- **THEN** the reset proceeds without a head-expectation check, exactly as an explicit "no expectation" does today
