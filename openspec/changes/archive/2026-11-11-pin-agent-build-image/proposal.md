# Proposal

## Why

The `release-agent` job builds the remote agent inside `rust:1.97.1-alpine`, pulled by a tag that its publisher can move. Every `uses:` in the workflow is already pinned by commit, so this image is the one unpinned input of a binary that GitLane signs and runs on users' servers. A replaced image would produce a correctly signed malicious agent. The gap was found in the security review of the remote agent (2026-11-11).

There is no Jira issue for this change.

## What Changes

The change touches the release workflow only. No Rust, frontend or IPC code changes.

- Pin the agent build image by digest: `rust:1.97.1-alpine@sha256:<digest>`. The tag stays in the reference as a label for readers; Docker resolves by the digest.
- Use the multi-arch index digest, because the job runs on an x86_64 and an arm64 runner.
- Name the image in one place, `.github/agent-build/Dockerfile` (a single `FROM` line; nothing is built from it). The release job reads the reference from there.
- Tie the image to the toolchain. The release job takes the Rust version from `rust-toolchain.toml` and refuses an image whose `RUST_VERSION` differs. Without that, a toolchain bump that misses the digest would make rustup download the new compiler at build time, unpinned.
- Check the pin in pull-request CI (the `JavaScript dependency audit` job, which already lints the workflows): the reference resolves, covers `linux/amd64` and `linux/arm64`, and carries the pinned Rust version. The image is inspected, never run.
- Let Dependabot refresh the digest when the tag is rebuilt for a base-image fix. Version bumps of the tag are ignored; they follow `rust-toolchain.toml` by hand.

The last three items came out of the code review of the first version of this change.

## Non-goals

- No change to how the agent is built, signed or published.
- No pinning of other images: this is the only `docker run` in `.github/workflows/`.
- No toolchain bump here. Moving to a newer Rust is its own change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs` is set: the change alters how a release is built, not what GitLane does.

## Impact

- `.github/workflows/release.yml`, `release-agent` job, the "Build the agent (static musl)" step.
- `.github/agent-build/Dockerfile` (new), `.github/workflows/ci.yml` (one step and one path filter), `.github/dependabot.yml` (one entry).
- The CI step takes effect only after this lands: pull-request CI runs the base branch's workflow.
- **Secrets and auth:** none involved. The signing step is untouched.
- **Risk:** a wrong digest fails the `release-agent` job, so no agent is published and the release run stops. It fails closed. The pinned image is first used by a real release run; the task checks the reference with Docker beforehand.
- The companion change `harden-remote-agent` covers the Rust fixes from the same review and shares no file with this one.
