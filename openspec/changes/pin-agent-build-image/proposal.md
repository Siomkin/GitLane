# Proposal

## Why

The `release-agent` job builds the remote agent inside `rust:1.97.1-alpine`, pulled by a tag that its publisher can move. Every `uses:` in the workflow is already pinned by commit, so this image is the one unpinned input of a binary that GitLane signs and runs on users' servers. A replaced image would produce a correctly signed malicious agent. The gap was found in the security review of the remote agent (2026-11-11).

There is no Jira issue for this change.

## What Changes

The change touches the release workflow only. No Rust, frontend or IPC code changes.

- Pin the agent build image by digest: `rust:1.97.1-alpine@sha256:<digest>`. The tag stays in the reference as a label for readers; Docker resolves by the digest.
- Use the multi-arch index digest, because the job runs on an x86_64 and an arm64 runner.
- Add a comment beside it: the digest changes together with the toolchain version (`rust-toolchain.toml` and `RUSTUP_TOOLCHAIN` in the same step).

## Non-goals

- No change to how the agent is built, signed or published.
- No pinning of other images: this is the only `docker run` in `.github/workflows/`.
- No automated digest updates (Dependabot or Renovate for Docker). A toolchain bump is rare and already a manual edit in two places.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs` is set: the change alters how a release is built, not what GitLane does.

## Impact

- `.github/workflows/release.yml`, `release-agent` job, the "Build the agent (static musl)" step.
- **Secrets and auth:** none involved. The signing step is untouched.
- **Risk:** a wrong digest fails the `release-agent` job, so no agent is published and the release run stops. It fails closed. The pinned image is first used by a real release run; the task checks the reference with Docker beforehand.
- The companion change `harden-remote-agent` covers the Rust fixes from the same review and shares no file with this one.
