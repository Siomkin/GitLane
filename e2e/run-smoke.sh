#!/usr/bin/env bash
# Build the app in a Linux container and run the WebDriver smoke against it.
# The source is copied in read-only (host node_modules are macOS binaries), and
# the cargo registry and target dir live in named volumes, so reruns are incremental.
set -euo pipefail
cd "$(dirname "$0")/.."

docker build -t gitlane-e2e -f e2e/Dockerfile e2e
docker run --rm \
  -v "$PWD:/src:ro" \
  -v gitlane-e2e-registry:/usr/local/cargo/registry \
  -v gitlane-e2e-target:/work/src-tauri/target \
  gitlane-e2e bash -euo pipefail -c '
    mkdir -p /work
    # Exit 1 is tar'"'"'s "file changed as we read it", which a macOS bind mount
    # reports for directories nothing is writing to; 2 is a real failure.
    { tar -C /src --exclude=./node_modules --exclude=./docs-site --exclude=./dist \
        --exclude=./src-tauri/target --exclude=./.git --exclude=./.claude \
        --warning=no-file-changed -cf - . || test $? -eq 1; } | tar -C /work -xf -
    cd /work
    bun install --frozen-lockfile
    # vite only: tsc + vite together exceed a 6 GB Docker VM (exit 137), and
    # typechecking is already gated in CI.
    bun run tauri build --debug --no-bundle --config "{\"build\":{\"beforeBuildCommand\":\"bun x vite build\"}}"
    xvfb-run -a bun e2e/smoke.mjs /work/src-tauri/target/debug/GitLane
  '
