## ADDED Requirements

### Requirement: A Stop sent before the agent starts still ends the run

When the user stops an agent run (an AI action, or an AI conflict resolve) whose agent process has not started yet, GitLane MUST NOT start it afterwards. If the process started while the Stop was being handled, GitLane MUST end it right away. The run MUST end as stopped, not as an answer or a timeout.

#### Scenario: Stop while the run is still queued
- **GIVEN** the user started an AI action and its agent process has not been launched yet
- **WHEN** the user presses Stop
- **THEN** no agent process is launched for that run, and the run ends as stopped

#### Scenario: Stop lands while the process is being launched
- **GIVEN** an agent run whose process is being launched
- **WHEN** the user presses Stop before the launch completes
- **THEN** the process and every process it started end straight after the launch, and the run produces no answer

#### Scenario: Stop after the run finished
- **WHEN** the user presses Stop on a run that has already answered
- **THEN** nothing is stopped and no error is shown

### Requirement: Stopping a run never signals a process outside it

When GitLane ends an agent or helper process, by a Stop, a timeout, or the normal end of the run, it MUST signal only that process and the processes it started. It MUST NOT send any signal for a process it has already collected, so a process that later reuses the same id is never affected.

#### Scenario: Stop after the agent exited on its own
- **GIVEN** an agent run whose process has already exited and been collected
- **WHEN** the run is stopped, or the timeout fires
- **THEN** GitLane sends no signal to any process

#### Scenario: Agent left a child running
- **GIVEN** an agent process that started a child of its own and is still running
- **WHEN** the user stops the run
- **THEN** both the agent process and its child end, and no other process on the machine is signalled
