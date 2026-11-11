# The image release.yml builds the remote agent in (the `release-agent` job).
# Nothing is built from this file: it is the one place the image is named, in
# the form Dependabot can refresh when the tag is rebuilt for a security fix.
#
# Pinned by its multi-arch index digest, so a moved tag cannot change the
# signed agent. The tag's Rust version must equal rust-toolchain.toml: CI
# checks that, and the release job refuses an image built for another version.
FROM rust:1.99.1-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383
