# System dependencies for the Linux WebDriver smoke (tauri-driver drives
# WebKitWebDriver; macOS has no WebKit driver, so this runs in Linux only).
# The image holds tools only. e2e/run-smoke.sh copies the source in at run time.
FROM rust:1.97.1-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    webkit2gtk-driver xvfb xauth \
  && rm -rf /var/lib/apt/lists/*

COPY --from=oven/bun:1.4.0 /usr/local/bin/bun /usr/local/bin/bun

RUN cargo install tauri-driver --locked --version 2.1.0
