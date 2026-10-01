# Spec Delta

## ADDED Requirements

### Requirement: An array-form execute command is validated as the argv that runs

When an agent's execute request carries its command as an argument array, the read-only
check SHALL validate those exact arguments. It SHALL never re-tokenise a joined string, so
the checked command and the executed command cannot differ.

#### Scenario: Quote characters that would merge arguments when re-split
- **WHEN** the request's argv is `["git","log","--format='","--output=/tmp/pwn","--grep='"]`
- **THEN** the request is not approved, because one argument is `--output=/tmp/pwn`

#### Scenario: Plain array form
- **WHEN** the request's argv is `["git","log","--oneline","-n","5"]`
- **THEN** it is approved exactly as the equivalent string command is
