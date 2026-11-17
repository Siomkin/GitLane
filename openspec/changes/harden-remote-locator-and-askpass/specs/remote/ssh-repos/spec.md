# Spec Delta

## ADDED Requirements

### Requirement: A path the server reports stays on that server

GitLane SHALL treat every repository, worktree or home path that a server's agent reports, and every worktree path the user types for a remote repository, as a path on that same server. Such a path that does not start with `/` SHALL be refused, and GitLane SHALL NOT connect to any other host, user or port because of it. A typed worktree path SHALL be refused before any worktree is created.

#### Scenario: Server reports a path without a leading slash

- **WHEN** the user opens `ssh://devbox/srv/app` and the server reports the repository path as `@other.example/srv/x`
- **THEN** opening the repository fails with an error, and GitLane makes no connection to `other.example`

#### Scenario: Worktree path without a leading slash

- **WHEN** a server lists a worktree whose path is `:2222/srv/wt`
- **THEN** the worktree list fails with an error, and no connection is made to port 2222 or any other host

#### Scenario: Typed worktree path without a leading slash

- **WHEN** on a remote tab the user creates a worktree at `wt/feature`
- **THEN** GitLane shows an error, creates no worktree on the server, and opens no tab

#### Scenario: Server home without a leading slash

- **WHEN** the open-remote folder browser connects, or a saved connection is tested, and the server reports its home directory as `other.example/home/me`
- **THEN** the browser starts at `/` on the same server

#### Scenario: Absolute paths keep working

- **WHEN** a server reports the repository path `/srv/app` and a worktree at `/srv/wt`
- **THEN** both open as `ssh://devbox/srv/app` and `ssh://devbox/srv/wt`

## MODIFIED Requirements

### Requirement: The connection uses the user's own SSH setup and asks in the app

GitLane SHALL connect with the user's installed `ssh` client and its configuration, keys and running agent. When `ssh` asks for a password, passphrase or one-time code, GitLane SHALL show ssh's prompt in an in-app dialog and pass the answer only to that connect attempt's `ssh` processes. GitLane SHALL reuse an answer for another `ssh` process of the same attempt only when the installed `ssh` is OpenSSH 8.4 or newer, the prompt is identical to the one answered, and the prompt names what it unlocks: a password prompt naming the user and host, a passphrase prompt naming the key file, or a prompt that ssh prefixes with the user and host. In every other case, including an `ssh` whose version cannot be determined, the prompt SHALL be asked in the app each time. The answer SHALL NOT be stored, logged or sent elsewhere, and SHALL be forgotten when the attempt ends. Cancelling SHALL fail the connection.

#### Scenario: One password for the whole connect

- **WHEN** the installed `ssh` is OpenSSH 8.4 or newer, a password-only server needs the agent installed so the connect runs several `ssh` processes, and each asks `me@devbox's password: `
- **THEN** the user is asked for the password once

#### Scenario: Older ssh asks every time

- **WHEN** the installed `ssh` is OpenSSH 8.1 and several `ssh` processes of one connect attempt each ask `me@devbox's password: `
- **THEN** the user is asked once for each process, and no answer is reused

#### Scenario: A prompt that names no host is asked again

- **WHEN** one `ssh` process of a connect attempt asks `Password: ` and the user answers, and a different `ssh` process of the same attempt then asks `Password: `
- **THEN** the user is asked again, and the first answer is not sent to the second process

#### Scenario: A server cannot borrow another host's prompt

- **WHEN** the installed `ssh` is OpenSSH 8.4 or newer, the user answered `me@jump's password: `, and a later server's keyboard-interactive prompt arrives as `(me@devbox) me@jump's password: `
- **THEN** the user is asked, and the answer for `jump` is not sent

#### Scenario: Key in the running agent

- **WHEN** the user's ssh-agent holds a key the server accepts
- **THEN** the repository opens without any prompt

#### Scenario: Server wants a password

- **WHEN** the server accepts only password authentication
- **THEN** GitLane shows a password dialog naming the host, and the repository opens once the correct password is entered

#### Scenario: Prompt during launch restore

- **WHEN** GitLane relaunches with a remote tab active and its host asks for a password
- **THEN** the password dialog is shown over the restoring workspace, and cancelling it leaves the tab in the disconnected state
