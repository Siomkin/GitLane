## Purpose

GitLane drives the user's real `git` binary, which reads configuration and environment from the
machine it runs on. This capability fixes what GitLane guarantees about that subprocess, so the
result of an operation depends on the repository and the user's request, never on how the user
happens to have configured or localized their git.

## Requirements

### Requirement: Git diagnostics reach GitLane in a stable language

Every git subprocess GitLane runs MUST produce its messages in a fixed language, so that error
classification and outcome detection cannot change with the user's locale. GitLane MUST NOT depend on
individual call sites opting into stable diagnostics.

#### Scenario: A conflict is reported on a localized system

- **WHEN** the user's session language is not English and a rebase, cherry-pick, or revert stops on a
  conflict
- **THEN** GitLane classifies the failure as a conflict and opens the conflict workspace
- **AND** the classification is identical to the one produced on an English system

#### Scenario: A stash succeeds on a localized system

- **WHEN** the user's session language is not English and a per-file stash succeeds
- **THEN** GitLane treats the stash as routine and does not surface git's raw output as a message

#### Scenario: A push is rejected on a localized system

- **WHEN** the user's session language is not English and a push is rejected as non-fast-forward
- **THEN** GitLane recognises the rejection and offers the same follow-up it offers in English

### Requirement: The commit identity GitLane pins is the identity that is used

When GitLane pins an author or committer identity for an operation, that identity MUST be the one
recorded in the resulting commit. An identity present in the environment GitLane was launched with
MUST NOT override it.

#### Scenario: The launching environment carries an author email

- **WHEN** GitLane is launched from a shell that exports an author or committer name, email, or date,
  and the user commits with an identity card applied
- **THEN** the commit's author and committer are the identity card's name and email
- **AND** no field is taken from the launching environment

#### Scenario: An operation deliberately replays an original author

- **WHEN** GitLane replays existing commits and pins each one's original author explicitly
- **THEN** each replayed commit keeps its original author name, email, and date

### Requirement: Machine-read git output carries no configuration-dependent decoration

Output that GitLane parses MUST contain only the records it asked for. Configuration that makes git
decorate, annotate, or verify its output MUST NOT change what GitLane reads.

#### Scenario: The user has signature display enabled

- **WHEN** the user's configuration displays signatures for every log command and the repository's
  commits are signed
- **THEN** recovery entries, operation previews, and commit replays read the intended records only
- **AND** no verification text appears as an entry, a listed commit, or a field value

#### Scenario: Repository-routing variables are present in the environment

- **WHEN** the environment GitLane inherits points git at a different repository, index, or object
  store
- **THEN** the operation acts on the repository the user opened
