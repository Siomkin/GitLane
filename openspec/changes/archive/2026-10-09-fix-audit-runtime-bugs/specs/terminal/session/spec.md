# Spec Delta

## ADDED Requirements

### Requirement: A repository tab's shells end when the tab leaves the strip

Whenever a repository tab is removed from the tab strip, for any reason, GitLane SHALL dispose of every terminal session that belongs to that tab. The reasons include closing the tab, an in-place worktree switch, falling back from a removed worktree, retiring a dead worktree, and Locate… re-keying a moved repository. No shell may keep running without a tab that shows it.

#### Scenario: In-place worktree switch
- **WHEN** a terminal is open in worktree A and the user switches the tab in place to worktree B
- **THEN** A's shell process is terminated and only B's terminals remain

#### Scenario: Removed worktree fallback
- **WHEN** the open worktree is removed externally and GitLane falls back to the main checkout
- **THEN** the removed worktree's shells are terminated

### Requirement: Typing into a terminal never blocks the interface and keeps its order

The pseudo-terminal write, which can block, SHALL NOT run on the UI thread and SHALL NOT run under the lock shared by all terminal sessions. Keystrokes SHALL reach the shell in the order they were typed.

#### Scenario: A child process stops reading input
- **WHEN** a program in one terminal stops reading stdin and the user keeps pasting input
- **THEN** the rest of the UI stays responsive, and other terminals can still be written to and killed

#### Scenario: Fast typing keeps its order
- **WHEN** the user types or pastes several chunks in quick succession
- **THEN** the shell receives the bytes in exactly the order they were typed
