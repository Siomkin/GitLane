## Purpose

Captures the security invariants GitLane relies on at the platform level: which URLs it will open, how updates are verified, how macOS builds are signed, which remote content the PR view may load, and how user-supplied paths reach operating-system openers.

## Requirements

### Requirement: External links open only with http, https, or mailto

GitLane MUST refuse to hand any URL whose scheme is not `http`, `https`, or `mailto` to the operating system, regardless of where the URL came from (forge metadata, PR markdown, commit messages). A refused link MUST be inert rather than opened inside the app window.

#### Scenario: javascript link in a PR body
- **WHEN** a pull-request description contains a link whose href begins with `javascript:`
- **THEN** activating it neither opens a browser nor executes anything, and the app window does not navigate

### Requirement: Every update is signature-verified on every channel

An update MUST be installed only if its artifact signature verifies against the public key built into the app. This MUST hold for the stable and the beta channel alike, and switching channel MUST NOT disable verification.

#### Scenario: beta channel manifest with an unsigned artifact
- **WHEN** the beta manifest points at an artifact whose signature does not verify
- **THEN** the update is refused with a visible error and the installed version is unchanged

### Requirement: macOS release builds are signed with a Developer ID and notarised

Release artifacts for macOS MUST be signed with a Developer ID certificate and notarised, so a first launch on a default-configured Mac does not require the user to override Gatekeeper. A release build MUST fail rather than publish an ad-hoc-signed artifact when the signing material is configured; when it is not configured, the build MUST label the artifact as unsigned in the release notes.

#### Scenario: fresh install on a default Mac
- **WHEN** a user downloads the stable DMG and opens the app for the first time
- **THEN** macOS launches it without a "cannot be opened because the developer cannot be verified" dialog

#### Scenario: signing secrets absent on a release run
- **WHEN** the release workflow runs without Apple signing secrets
- **THEN** the run still produces artifacts, and the release notes state that the macOS build is unsigned

### Requirement: PR markdown image policy and content-security policy agree

The set of image sources the pull-request markdown renderer accepts MUST be the same set the content-security policy allows. An image from any other host MUST be replaced by its alt text, never left as a broken image.

#### Scenario: badge from an allowed host
- **WHEN** a PR body embeds an image from a host on the allow-list
- **THEN** the image renders

#### Scenario: image from a host outside the allow-list
- **WHEN** a PR body embeds an image from a host not on the allow-list
- **THEN** the alt text is shown in its place and no request is made to that host

### Requirement: User paths reach OS openers as paths, never as options

When GitLane asks the operating system to reveal or open a repository path, the path MUST be passed so that it cannot be interpreted as an option, even when it begins with `-`.

#### Scenario: repository directory named with a leading dash
- **WHEN** the user reveals a worktree whose directory name begins with `-`
- **THEN** the file manager opens that directory, and no opener reports an unknown option
