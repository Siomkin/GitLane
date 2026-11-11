# Tasks

## 1. Release workflow

- [x] 1.1 Look up the multi-arch index digest: `docker buildx imagetools inspect rust:1.97.1-alpine --format '{{.Manifest.Digest}}'`. Verify: the output is one `sha256:` value, and the plain `docker buildx imagetools inspect rust:1.97.1-alpine` lists both `linux/amd64` and `linux/arm64`.
- [x] 1.2 In `.github/workflows/release.yml`, `release-agent` job, step "Build the agent (static musl)", change `rust:1.97.1-alpine` to `rust:1.97.1-alpine@sha256:<digest from 1.1>`. Add a comment above the step that the digest changes together with the toolchain version. Verify: `docker buildx imagetools inspect` on the full pinned reference succeeds and prints the same digest.
- [x] 1.3 Check the pinned image still builds the agent: run the step's `docker run … cargo build --profile agent --no-default-features --features agent --bin gitlane-agent` locally with the pinned reference, from the repository root. Verify: it exits 0 and `src-tauri/target-agent/agent/gitlane-agent` exists. Remove `src-tauri/target-agent/` afterwards.
  - Done with one deviation: on this Mac the step's exact command crashed rustc with SIGBUS twice, in a different crate each time, because the target directory sat on a Docker Desktop bind mount from an external volume. The same image and cargo command with `CARGO_TARGET_DIR` on the container's own filesystem exited 0 and produced a static aarch64 binary. The amd64 image of the same digest was built later the same way under emulation (14m52s), and that binary installed and ran on an Ubuntu 26.04 x86_64 host.
- [x] 1.4 Check the workflow file still parses: `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/release.yml"))'` exits 0, and `git diff --stat` shows `release.yml` as the only changed file.

## 2. Review follow-up: tie the image to the toolchain

- [x] 2.1 Add `.github/agent-build/Dockerfile` with the pinned `FROM` line, and make the release step read the image from it and the Rust version from `rust-toolchain.toml`. Verify: the step as written builds the agent locally with the build output kept inside the container.
- [x] 2.2 In the release step, refuse an image whose `RUST_VERSION` differs from the pinned toolchain, without calling `rustup` (asking `rustup` about a missing toolchain downloads it). Verify: with `rust-toolchain.toml` set to another version the step exits 1 with the "Update .github/agent-build/Dockerfile" message and builds nothing.
- [x] 2.3 Add the "Check the agent build image pin" step to the `security-js` job in `ci.yml` and `.github/agent-build/**` to the `security` path filter. Verify by running the step as written: it passes on the real pin, and fails for a toolchain bump without a Dockerfile change, for a new tag text over the old digest, and for a digest the registry does not have.
- [x] 2.4 Add the `docker` entry for `/.github/agent-build` to `.github/dependabot.yml`, ignoring version updates of `rust`. Verify: the file parses. Whether Dependabot opens digest-only refreshes for this layout shows only after it lands.
