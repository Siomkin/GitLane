## MODIFIED Requirements

### Requirement: macOS release builds are signed with a Developer ID and notarised

Release artifacts for macOS MUST be signed with a Developer ID certificate and notarised, so a first launch on a default-configured Mac does not require the user to override Gatekeeper. A release build MUST fail rather than publish an ad-hoc-signed artifact when the signing material is configured; when it is not configured, the build MUST label the artifact as unsigned in the release notes.

Whether signing material is configured MUST be decided at run time inside the release run from the presence of the configured secrets, and MUST NOT depend on the workflow definition being evaluated against secret values. The release workflow MUST start its jobs on every release tag push whether or not signing secrets are configured, and a push that is not a release tag MUST NOT produce a Release workflow run at all.

#### Scenario: fresh install on a default Mac
- **WHEN** a user downloads the stable DMG and opens the app for the first time
- **THEN** macOS launches it without a "cannot be opened because the developer cannot be verified" dialog

#### Scenario: signing secrets absent on a release run
- **WHEN** the release workflow runs without Apple signing secrets
- **THEN** the run still produces artifacts, and the release notes state that the macOS build is unsigned

#### Scenario: release tag pushed with partially configured secrets
- **WHEN** a `v*` tag is pushed while `APPLE_CERTIFICATE` is set but another required signing secret is empty
- **THEN** the run starts, the macOS leg fails with a message naming the missing secret, and no ad-hoc-signed macOS artifact is published

#### Scenario: ordinary branch push
- **WHEN** a commit is pushed to any branch without a release tag
- **THEN** no Release workflow run is created, failed or otherwise
