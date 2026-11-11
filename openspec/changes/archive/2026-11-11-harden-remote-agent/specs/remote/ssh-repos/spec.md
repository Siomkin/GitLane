# Spec Delta

## ADDED Requirements

### Requirement: The installed agent is private to the connecting user

The directory GitLane installs its agent into, and everything GitLane puts in it, SHALL be readable, writable and searchable by the connecting user only, whatever the server's default file permissions are. Each connect SHALL bring an existing agent directory with wider permissions back to that state before the agent runs.

#### Scenario: Server with group-writable defaults

- **WHEN** GitLane installs the agent on a server whose default permissions make new directories group-writable
- **THEN** the agent directory and its version directories grant no access to the group or to others

#### Scenario: Install made by an earlier version

- **WHEN** the user connects to a server whose agent directory was created group-writable by an earlier GitLane version
- **THEN** the agent directory grants no access to the group or to others before the agent starts

### Requirement: Only an agent owned by the connecting user is run

GitLane SHALL run an agent on the server only when the agent file and the directories GitLane keeps it in are owned by the connecting user. It SHALL NOT write into an agent directory owned by another account. Where the server does not report even the user's home directory as theirs, ownership cannot be judged and this check SHALL NOT block the connect.

#### Scenario: Home directory on a mount that maps owners

- **WHEN** the server reports the connecting user's own home directory as owned by another account
- **THEN** GitLane installs and runs the agent as it does elsewhere, protected by the owner-only permissions alone

#### Scenario: Agent file placed by another account

- **WHEN** the agent file for the app's version exists on the server but is owned by another account
- **THEN** GitLane does not run it, and installs its own verified agent in its place before opening the repository

#### Scenario: Agent directory owned by another account

- **WHEN** the agent directory for the app's version is owned by another account
- **THEN** GitLane runs nothing from it and writes nothing into it, and opening fails with an error that names the directory and says to remove it on the server

### Requirement: A server's change notices apply only to that server

GitLane SHALL treat a change notice from a server as naming a repository on that server and no other host. A notice whose path is not an absolute path on the server SHALL be ignored.

#### Scenario: Notice with a path that is not absolute

- **WHEN** a server's agent reports a change for a path that does not start with `/`
- **THEN** no open repository is refreshed, on that server or any other

#### Scenario: Notice for an open repository

- **WHEN** a server's agent reports a change for the absolute path of a repository open from that server
- **THEN** that repository's tab refreshes

## MODIFIED Requirements

### Requirement: Only a verified agent is installed

GitLane SHALL install an agent binary only after verifying that it is signed with GitLane's release key. The check SHALL run for every installation, including one made from a copy GitLane kept from an earlier download. When verification fails, GitLane SHALL install nothing and opening SHALL fail with an integrity error. A release build SHALL offer no way to install an agent without this check.

#### Scenario: Tampered download

- **WHEN** the agent binary obtained for installation fails signature verification
- **THEN** nothing is uploaded to the server, and opening fails with an integrity error

#### Scenario: Kept copy was changed

- **WHEN** the copy of the agent GitLane kept on this computer no longer matches its signature
- **THEN** GitLane does not upload it, downloads the agent again, and installs it only after verifying the download

#### Scenario: Development override in a release build

- **WHEN** a release build of GitLane starts with the development setting that names a local agent file
- **THEN** the setting is ignored, and only a verified agent is installed
