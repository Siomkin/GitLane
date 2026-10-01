# Spec Delta

## ADDED Requirements

### Requirement: Every checkout's detached HEAD is in the graph of every worktree tab

The commit graph SHALL include the detached HEAD commit of every checkout of the
repository, including the main checkout when the open tab is a linked worktree.

#### Scenario: Main checkout detached on an unreferenced commit
- **WHEN** the main checkout is detached on a commit no ref reaches, and the user opens a linked worktree of the same repository
- **THEN** that commit is in the graph with its worktree pill
