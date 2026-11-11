# Tasks

## 1. Release workflow

- [x] 1.1 Look up the multi-arch index digest: `docker buildx imagetools inspect rust:1.97.1-alpine --format '{{.Manifest.Digest}}'`. Verify: the output is one `sha256:` value, and the plain `docker buildx imagetools inspect rust:1.97.1-alpine` lists both `linux/amd64` and `linux/arm64`.
- [x] 1.2 In `.github/workflows/release.yml`, `release-agent` job, step "Build the agent (static musl)", change `rust:1.97.1-alpine` to `rust:1.97.1-alpine@sha256:<digest from 1.1>`. Add a comment above the step that the digest changes together with the toolchain version. Verify: `docker buildx imagetools inspect` on the full pinned reference succeeds and prints the same digest.
- [x] 1.3 Check the pinned image still builds the agent: run the step's `docker run … cargo build --profile agent --no-default-features --features agent --bin gitlane-agent` locally with the pinned reference, from the repository root. Verify: it exits 0 and `src-tauri/target-agent/agent/gitlane-agent` exists. Remove `src-tauri/target-agent/` afterwards.
  - Done with one deviation: on this Mac the step's exact command crashed rustc with SIGBUS twice, in a different crate each time, because the target directory sat on a Docker Desktop bind mount from an external volume. The same image and cargo command with `CARGO_TARGET_DIR` on the container's own filesystem exited 0 and produced a static aarch64 binary. The amd64 image of the same digest was built later the same way under emulation (14m52s), and that binary installed and ran on an Ubuntu 26.04 x86_64 host.
- [x] 1.4 Check the workflow file still parses: `python3 -c 'import yaml,sys; yaml.safe_load(open(".github/workflows/release.yml"))'` exits 0, and `git diff --stat` shows `release.yml` as the only changed file.
