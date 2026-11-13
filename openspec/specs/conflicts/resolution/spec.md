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

### Requirement: The agent answers per conflict

The prompt MUST label each conflict of each file with its number, and MUST ask the agent for only the replacement of each numbered conflict, not the whole file. GitLane MUST rebuild each file from those replacements, keeping every line outside the conflicts and the file's line endings. A file with a numbered conflict left unanswered, or whose markers cannot be numbered unambiguously, MUST show its own error. An answer that gives a whole file instead MUST still be accepted.

#### Scenario: Large file, one-line conflict
- **GIVEN** a 2,000-line file with one conflict
- **WHEN** the agent answers with that conflict's replacement
- **THEN** the proposal is the whole file with only that conflict replaced

#### Scenario: Conflict left unanswered
- **GIVEN** a file with two conflicts
- **WHEN** the agent answers only conflict 1
- **THEN** the file shows an error and no proposal

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

### Requirement: Stop ends the whole request

While a request is in flight, every targeted file MUST show it is resolving. Stop on any file of the request MUST end the agent session and discard every file's result in that request, because they share one session. A file resolved or discarded by hand MUST drop only that file, and the session MUST end once no file in the request is still waiting. Switching repository MUST end the session.

#### Scenario: Stop one of three
- **GIVEN** a "Resolve all" request in flight for `a.ts`, `b.ts`, `c.ts`
- **WHEN** the user presses Stop on `b.ts`
- **THEN** the agent session ends, and none of the three files lands a proposal

#### Scenario: A file resolved by hand mid-request
- **GIVEN** a "Resolve all" request in flight for `a.ts` and `b.ts`
- **WHEN** the user resolves `b.ts` by hand
- **THEN** the session keeps running, and only `a.ts` lands when it answers

### Requirement: An oversized request is refused before it starts

When the targeted files' conflicted content is larger than GitLane's size budget for one request, GitLane MUST refuse to start it and tell the user to resolve files individually. It MUST NOT split the request into several sessions.

#### Scenario: Large merge
- **GIVEN** unresolved text conflicts whose combined content exceeds the budget
- **WHEN** the user picks "Resolve all"
- **THEN** no agent session starts, and the user is told the set is too large for one pass

### Requirement: Aborting a carry never destroys work outside the recovery stashes

When HEAD differs from where a worktree-handoff carry was applied, aborting it MUST end the carry without changing any file and MUST keep the recovery stashes. Otherwise aborting MUST save the tracked and staged worktree content to a named stash before discarding it, including when conflicts are unresolved.

#### Scenario: HEAD moved since the carry

- **WHEN** a carry marker is still active, the user has since moved HEAD, and the user aborts the carry
- **THEN** the carry ends, no file changes, and the recovery stashes remain

#### Scenario: Edits made after the carry

- **WHEN** the user edited tracked files after the carry and then aborts it
- **THEN** the worktree returns to HEAD and those edits are available in a stash named as a carry abort backup

#### Scenario: A file staged after the carry

- **WHEN** the user staged a new file after the carry and then aborts it
- **THEN** that file is available in the backup stash

#### Scenario: Unresolved conflicts at abort

- **WHEN** the carry still has unmerged files and the user aborts it
- **THEN** the abort succeeds and the backup stash holds the conflicted content

#### Scenario: Nothing to back up

- **WHEN** tracked files already match HEAD and the user aborts the carry
- **THEN** no backup stash is created

#### Scenario: The confirmation is accurate

- **WHEN** the abort confirmation is shown
- **THEN** it states that tracked changes are saved to a backup stash before being discarded
