# Spec Delta

## ADDED Requirements

### Requirement: Write-error recovery acts on the repository that failed

A failed write's error toast SHALL bind its retry and index-lock recovery to the repository where the write ran. If that repository is no longer the open one, recovery MUST NOT inspect, remove locks in, or re-run the write against a different repository.

#### Scenario: Repo switch while a stage is in flight
- **WHEN** a stage in repo A fails with `indexLock` after the user has switched to repo B
- **THEN** "Remove lock & retry" never touches B's `.git/index.lock`, and it does not stage anything in B

### Requirement: The conflict list names the deleting side in terms of the running operation

For a modify/delete conflict, the conflict file list SHALL use the same operation-aware side names as the conflict editor. During a rebase or carry, where git's ours/theirs are reversed from the user's point of view, the list MUST NOT say the user deleted a file that upstream deleted.

#### Scenario: Upstream deleted a file during a rebase
- **WHEN** a rebase stops on a modify/delete conflict where the commit being rebased onto deleted the file
- **THEN** the list row and the editor both attribute the deletion to the rebased-onto side
