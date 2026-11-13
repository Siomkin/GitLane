# The image release.yml builds the remote agent in (the `release-agent` job).
# Nothing is built from this file: it is the one place the image is named, in
# the form Dependabot can refresh when the tag is rebuilt for a security fix.
#
# Pinned by its multi-arch index digest, so a moved tag cannot change the
# signed agent. The tag's Rust version must equal rust-toolchain.toml: CI
# checks that, and the release job refuses an image built for another version.
FROM rust:1.100.0-alpine@sha256:de1e0058543a81ed7b046629167db587c67a94bdf37cce14eb27f0ec83baaffb
