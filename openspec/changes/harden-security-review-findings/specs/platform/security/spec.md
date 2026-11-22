# Spec Delta

## ADDED Requirements

### Requirement: Worktree file reads refuse repository metadata inside .git

Every operation that returns worktree file content over IPC, locally or over the remote SSH agent, MUST refuse any repo-relative path containing a `.git` component, matched case-insensitively, so repository configuration, hooks, and internal state cannot be read through worktree file APIs. Operations that never return file content are outside this requirement.

#### Scenario: Text read targeting .git/config
- **WHEN** a caller requests worktree text for `.git/config` or `.GIT/config`
- **THEN** GitLane refuses the read with an error and returns no file content

#### Scenario: Binary blob read targeting .git metadata
- **WHEN** a caller requests a working-tree binary blob for `.git/index` or `nested/.gIt/hooks/pre-commit`
- **THEN** GitLane refuses the read with an error and returns no bytes

#### Scenario: Ordinary file whose name only resembles .git
- **WHEN** a caller requests worktree text for `.gitignore` or `docs/.github/notes.md`
- **THEN** GitLane returns the file content
