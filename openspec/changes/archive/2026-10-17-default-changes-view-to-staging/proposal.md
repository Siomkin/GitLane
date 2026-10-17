# Proposal

## Why

`add-commit-review-workspace` (#475) made the Include view the Changes tab's default. That hid the
staged/unstaged lists and the per-hunk Stage/Unstage controls behind a second tab, which changed
the workflow people already use too much. The Include view stays, but the Changes tab opens in the
Staging-area view again, and Include becomes the optional view.

Jira: none.

## What Changes

- `changes/commit`: the "Staging-area view keeps staged and unstaged separate" requirement now
  says the workspace opens in the Staging-area view and the Include view is optional. Its switch
  scenario runs from Staging area to Include, and a new scenario covers the default.
- Every other Include-view requirement is unchanged.

Docs only. No code changes.
