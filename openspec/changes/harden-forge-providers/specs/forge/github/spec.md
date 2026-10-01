# Spec Delta

## ADDED Requirements

### Requirement: GitHub write failures name the repository's host and account

An authentication failure from any GitHub pull-request operation on an open repository,
read or write, SHALL name that repository's host and the bound account, never a default
host.

#### Scenario: Merge on GitHub Enterprise with a revoked token
- **WHEN** the repository is on `ghe.example.com`, bound to login `jdoe`, and `gh pr merge` fails with an authentication error
- **THEN** the error tells the user to authenticate `jdoe` on `ghe.example.com`, and does not mention `github.com`

#### Scenario: Reads and writes agree
- **WHEN** a list read and an approve on the same repository both fail authentication
- **THEN** both errors name the same host and account
