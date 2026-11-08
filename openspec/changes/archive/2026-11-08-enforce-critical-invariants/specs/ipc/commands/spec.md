# Spec Delta

## MODIFIED Requirements

### Requirement: Every error crossing IPC is redacted at one chokepoint

Any error rejection delivered to the frontend MUST have passed through the secret redaction step regardless of which module produced it. Provider tokens, HTTPS passwords, URL-embedded credentials, and one-time device codes MUST be replaced by `***`, whether or not the text contains a URL. This MUST cover recognised bare tokens, `Authorization` header values, and token query parameters, and the same text written to a log.

#### Scenario: token in a git remote error
- **WHEN** `git fetch` fails with a message containing an `https://user:TOKEN@host/…` URL
- **THEN** the delivered `message` and `detail` contain `***` in place of the token

#### Scenario: forge CLI error containing a device code
- **WHEN** a GitHub sign-in child exits with output that includes the one-time device code
- **THEN** the delivered error does not contain the device code

#### Scenario: A bare token in stderr
- **WHEN** a server message reads `remote: invalid token glpat-abc123`
- **THEN** the displayed and logged text does not contain `glpat-abc123`

#### Scenario: An Authorization header in debug output
- **WHEN** tool output includes `Authorization: Bearer abc123`
- **THEN** the displayed and logged text does not contain `abc123`

#### Scenario: A token query parameter
- **WHEN** error text contains a URL with `?private_token=abc123` or `?access_token=abc123`
- **THEN** the displayed and logged text does not contain `abc123`

#### Scenario: An Atlassian API token in a remote URL
- **WHEN** a remote URL has a username beginning `ATATT`
- **THEN** it is treated as a secret rather than an account name

#### Scenario: Ordinary text is unchanged
- **WHEN** error text has no token-shaped content
- **THEN** it is delivered unchanged
