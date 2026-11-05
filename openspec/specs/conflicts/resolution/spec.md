# conflicts/resolution Specification

## Purpose

AI-assisted resolution of merge and rebase conflicts: how a resolve request reaches the agent, and how its answer becomes per-file proposals the user reviews before anything is written.

## Requirements

### Requirement: One resolve request is one agent session

GitLane MUST send each AI resolve request to the agent as a single session with a single prompt, whether it targets one file or every unresolved text conflict. A "Resolve all" request MUST NOT start one agent session per file.

#### Scenario: Resolve all with three conflicted files
- **GIVEN** three unresolved text conflicts
- **WHEN** the user picks "Resolve all" with an agent
- **THEN** exactly one agent session is started, and its prompt contains all three files

#### Scenario: Resolve one file
- **WHEN** the user picks "Resolve with AI" on one conflicted file
- **THEN** exactly one agent session is started, and its prompt contains only that file

### Requirement: The agent sees every targeted file with its note

The prompt MUST include each targeted file's path, its full worktree content with conflict markers, and the user's note for that file when one was entered. Binary conflicts MUST NOT be included.

#### Scenario: Note attached to its file
- **GIVEN** the user wrote "keep our logging" on `a.ts` and nothing on `b.ts`
- **WHEN** "Resolve all" starts
- **THEN** the prompt shows that note with `a.ts`, and no note with `b.ts`

#### Scenario: Binary conflict skipped
- **GIVEN** one text conflict and one binary conflict
- **WHEN** "Resolve all" starts
- **THEN** only the text file is sent to the agent

### Requirement: Each file is judged on its own

GitLane MUST match the agent's answer to files by path and judge each file separately. A file with no answer, an empty answer, leftover conflict markers, or a file that changed on disk while the agent ran MUST show its own error. Every other file in the same request MUST still land its proposal.

#### Scenario: One file missing from the answer
- **GIVEN** a request for `a.ts` and `b.ts`
- **WHEN** the agent returns a resolved body for `a.ts` only
- **THEN** `a.ts` shows a proposal in its Output pane, and `b.ts` shows that the agent didn't return it

#### Scenario: One file left with markers
- **WHEN** the agent's body for `b.ts` still contains `<<<<<<<` / `>>>>>>>` lines
- **THEN** `b.ts` shows an error and no proposal, and `a.ts` lands its proposal

#### Scenario: File changed during the run
- **GIVEN** `a.ts` was edited on disk after the request started
- **WHEN** the answer arrives
- **THEN** `a.ts` is refused with a "changed on disk" error, and the other files land

#### Scenario: File content with its own code fences
- **GIVEN** a conflicted Markdown file that contains fenced code blocks
- **WHEN** the agent returns its resolved body
- **THEN** the proposal keeps those fenced blocks intact

### Requirement: Proposals wait for review

A landed proposal MUST appear in that file's Output pane only. Nothing MUST be written to the worktree or staged until the user applies it, and the agent MUST NOT be allowed to write files itself.

#### Scenario: Sweep finishes
- **WHEN** a "Resolve all" answer lands for every file
- **THEN** each file shows a proposal awaiting Apply & stage or Discard, and the worktree is unchanged

### Requirement: Stopping one file leaves the rest of the request running

While a request is in flight, every targeted file MUST show it is resolving. Stopping one file MUST discard only that file's result, and the agent session MUST end only when no file in the request is still waiting. Stopping all, or switching repository, MUST end the session.

#### Scenario: Stop one of three
- **GIVEN** a "Resolve all" request in flight for `a.ts`, `b.ts`, `c.ts`
- **WHEN** the user stops `b.ts`
- **THEN** the session keeps running, `a.ts` and `c.ts` land when it answers, and `b.ts` lands nothing

#### Scenario: Stop every file
- **WHEN** the user stops each file of the request in turn
- **THEN** the agent session ends after the last one is stopped

### Requirement: An oversized request is refused before it starts

When the targeted files' conflicted content is larger than GitLane's size budget for one request, GitLane MUST refuse to start it and tell the user to resolve files individually. It MUST NOT split the request into several sessions.

#### Scenario: Large merge
- **GIVEN** unresolved text conflicts whose combined content exceeds the budget
- **WHEN** the user picks "Resolve all"
- **THEN** no agent session starts, and the user is told the set is too large for one pass
