## ADDED Requirements

### Requirement: Review threads show an anchored diff snippet when one is available

GitLane SHALL display a read-only diff snippet on a review-thread card when the selected provider supplies an anchored hunk for that thread. The snippet MUST reflect the provider-supplied hunk and MUST NOT invite the user to edit it. GitLane MUST NOT reconstruct a replacement hunk from local git when the provider omitted one.

#### Scenario: Thread has an anchored hunk
- **WHEN** a selected pull request has a review thread and the provider supplied an anchored hunk for it
- **THEN** the thread card shows that snippet along with the existing file, line, and comments

#### Scenario: Thread has no hunk
- **WHEN** a selected pull request has a review thread and the provider did not supply an anchored hunk
- **THEN** GitLane still shows the thread card and omits the snippet

#### Scenario: Snippet is not editable
- **WHEN** a thread card shows a diff snippet
- **THEN** the snippet is read-only and offers no control that edits the hunk or submits review text
