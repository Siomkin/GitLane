## ADDED Requirements

### Requirement: A failed remote-branch checkout retry reports its real cause

When checking out a remote-tracking ref retries moving the local branch, because the remote ref moved after the first attempt, and that retry fails, GitLane SHALL report the underlying git error together with the retry context, with secrets redacted. The error SHALL still ask the user to refresh and try again.

#### Scenario: Retry fails for a reason other than the remote moving
- **WHEN** the user checks out `origin/develop`, the first update of the local `develop` fails, `origin/develop` moved in the meantime, and the retry fails because the `develop` ref cannot be updated (for example, its lock file is held)
- **THEN** the checkout is refused, and HEAD and the working tree are unchanged
- **AND** the error names the underlying git failure, not only that `origin/develop` changed
- **AND** the error asks the user to refresh and try again

#### Scenario: Error text never carries a credential
- **WHEN** a retry failure's git output contains a credential, such as a token embedded in a remote URL
- **THEN** the reported error shows the redacted form, not the credential
