# Proposal

## Why

The SSH toolbar chip for a remote repository gives wrong information. Its tooltip says the terminal is off, but the remote terminal has shipped and works. It also says pull requests are off, even though the PR code already runs in the `gitlane-agent` build: with no account bound, `forge::context()` uses whatever `gh` / `glab` login the server has. When the server has no forge login, nothing tells the user what to run on the server to fix that.

No Jira issue exists for this change.

## What Changes

- Fix the SSH chip's tooltip so it lists only what is really off for remote repositories: file editing, OS openers and agents. The terminal and pull requests are on. This is a bug fix; the `remote/ssh-repos` spec already lists the terminal as available.
- Turn on pull requests for remote repositories whose remote is on **GitHub** (the server's `gh`) or **GitLab** (the server's `glab`). This covers reads (list, detail, diff, checks, commits, threads, stacks, reviewer candidates) and writes (create, merge, approve, set state, resolve thread, link or merge a stack). Every call runs on the server under the server's own login. The UI names that login, so it is clear who acts.
- Keep pull requests off, with a stated reason, for Bitbucket and Cursor Origin remotes on a remote repository. Bitbucket needs a GitLane keychain token, and the agent has no keychain. Cursor Origin needs the user's local `origin` session.
- Add a remote-capable status probe. For the repository's remote host, it reports whether the server's `gh` / `glab` is installed, new enough, and logged in, and as whom. The SSH chip and the PR panel show the result. When the server is not logged in, they show the exact command to run on the server (for example `gh auth login --hostname github.com`) and an **Open terminal** action that opens the remote terminal.
- When a fetch, pull or push on a remote repository fails authentication, the error names the server and the remote host and gives the same server-side fixes: log `gh` / `glab` in on the server, set up a credential helper there, or switch to an SSH remote URL. It never suggests this computer's accounts.
- Strip the `account` argument from forwarded calls, alongside `auth` / `remoteAccounts`, so a desktop-bound GitHub account ref never reaches the server.

## Non-goals

- Running `gh auth login` / `glab auth login` for the user, or driving a sign-in flow over SSH. The user runs the command in the remote terminal.
- Pull requests for Bitbucket or Cursor Origin remotes on remote repositories.
- Choosing among several `gh` accounts on the server. The server's active account for the host is used.
- Sending any desktop token, account ref or keychain secret to the server.
- Agent sessions, file editing and OS openers on remote repositories. They stay off.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `remote/ssh-repos`: Five requirements change.
  - Features unavailable on remote repositories: pull requests leave the list.
  - GitHub remotes use the server's own gh login: the failure now gives actionable server-side guidance.
  - The hosting provider is shown for a remote repository: pull-request views are no longer always disabled.
  - Pull requests on a remote repository use the server's forge login: new requirement.
  - The server's forge login is shown with how to fix it: new requirement.

## Impact

- **Processes:** Rust (agent dispatch table, `LOCAL_ONLY`, a new probe command, a hint for remote auth errors) and frontend (SSH chip, PR tab gate, pulls store, PR panel empty and error states). IPC: one new remote-capable command, and the PR commands move from local-only to remote-capable.
- **Code to copy:**
  - Remote-capable entries follow the existing ones in `src-tauri/src/agent/dispatch.rs`.
  - Probing the server's `gh` reuses `forge::accounts()` and the `require_supported_gh` path behind `transport_auth::server_gh_credential`.
  - Remote error shaping follows `src-tauri/src/remote/ssh_errors.rs`.
  - The remote gate stays `useIsRemoteRepo`.
- **Secrets / auth risk:**
  - No user-entered secret is added, and no new command carries a credential.
  - PR commands' `account` ref is stripped before forwarding, and again in the agent.
  - The probe returns only non-secret facts: tool name, version support, host, login.
  - PR writes act as the server's identity, so the UI must show that login before a write.
- **Docs:** update the remote section of `CLAUDE.md` ("Local-only features …", "Credentials").
