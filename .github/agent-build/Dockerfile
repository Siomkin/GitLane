# The image release.yml builds the remote agent in (the `release-agent` job).
# Nothing is built from this file: it is the one place the image is named, in
# the form Dependabot can refresh when the tag is rebuilt for a security fix.
#
# Pinned by its multi-arch index digest, so a moved tag cannot change the
# signed agent. The tag's Rust version must equal rust-toolchain.toml: CI
# checks that, and the release job refuses an image built for another version.
FROM rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900
