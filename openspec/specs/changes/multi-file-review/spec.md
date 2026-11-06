# changes/multi-file-review Specification

## Purpose

Covers the Changes tab's multi-file staging review: the list of every changed file, with
expandable diffs and a stage/unstage checkbox per file, and how those diffs stay current
as the working tree changes.

## Requirements

### Requirement: Open diffs stay visible while the working tree is re-read

When the working tree of the same repository is re-read while the multi-file review is open,
each expanded file that already shows a diff SHALL keep showing it until that file's new diff
arrives, then show the new one. The review MUST NOT replace a shown diff with a loading
placeholder because of the re-read.

#### Scenario: Staging one file does not blank the other open diffs

- **GIVEN** files `a.ts` and `b.ts` are expanded in the multi-file review with their diffs shown
- **WHEN** the user ticks `a.ts` to stage it and the review refreshes once from the stage action
  and once from the file watcher
- **THEN** `b.ts` keeps showing a diff throughout, without a "Loading diff…" placeholder
- **AND** after the refreshes `b.ts` shows the diff read from the latest working tree

#### Scenario: A re-read with changed content updates the open diff

- **GIVEN** `a.ts` is expanded with its diff shown
- **WHEN** a watcher refresh arrives after `a.ts` was edited outside GitLane
- **THEN** `a.ts` keeps its previous diff until the new one is read
- **AND** then shows the new diff

#### Scenario: A file with no diff on screen still shows loading

- **WHEN** the user expands a file whose diff has not been read in this review
- **THEN** the file shows "Loading diff…" until its diff arrives

### Requirement: Every working-tree re-read refetches open diffs

Each new working-tree read SHALL refetch the diff of every expanded file, even when the file's
status and line counts are unchanged. A diff read from an earlier working tree MUST NOT replace
one read from a later working tree.

#### Scenario: Identical counts still refetch

- **GIVEN** `a.ts` is expanded with its diff shown
- **WHEN** a refresh arrives whose entry for `a.ts` has the same status and line counts
- **THEN** the review reads `a.ts`'s diff again and shows the result

#### Scenario: A late result from an older read is dropped

- **GIVEN** a diff read for `a.ts` is still in flight when a newer working-tree read arrives
- **WHEN** the older read finishes after the newer one started
- **THEN** the review does not show the older read's result as current

### Requirement: Switching repositories never shows the previous repository's diff

When the review switches to another repository, it SHALL drop every diff it was showing, so a
file at the same path in the new repository shows a loading placeholder and then its own diff.

#### Scenario: Same path in another repository

- **GIVEN** `a.ts` is expanded with its diff shown in repository A
- **WHEN** the tab switches to repository B, which also has a changed `a.ts`
- **THEN** `a.ts` shows "Loading diff…" and then repository B's diff, never repository A's
