# Spec Delta

## ADDED Requirements

### Requirement: The login-shell PATH comes only from the probe's own output, within a timeout

GitLane SHALL take the login shell's PATH only from text its probe prints, ignoring
anything the user's shell startup files print. The probe SHALL be abandoned after a bounded
time, and GitLane then falls back to the inherited PATH.

#### Scenario: Shell startup file prints a greeting
- **WHEN** the user's `.zshrc` prints "Welcome back" and PATH is `/opt/homebrew/bin:/usr/bin`
- **THEN** GitLane's PATH starts with `/opt/homebrew/bin`, and `gh` and Homebrew `git` are found

#### Scenario: Shell startup file hangs
- **WHEN** the login shell does not exit
- **THEN** git, gh and agent launches proceed with the fallback PATH after the timeout instead of blocking
