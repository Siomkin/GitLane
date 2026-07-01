# Release channels (stable + beta)

GitLane ships desktop builds through the Tauri v2 updater. Tauri has **no
built-in channel concept** ([docs](https://v2.tauri.app/plugin/updater/)), so
channels are implemented by pointing each build at a channel-specific update
manifest. There are two:

| Channel | Updater endpoint | GitHub source |
| --- | --- | --- |
| **stable** (default) | `releases/latest/download/latest.json` | the newest **non-pre-release** release (`/latest/` alias) |
| **beta** | `releases/download/beta/latest.json` | a fixed `beta` release holding a **rolling** `latest.json` |

A build's channel is baked into its artifacts at build time:

- **Stable** builds use the endpoint in [`tauri.conf.json`](../src-tauri/tauri.conf.json).
- **Beta** builds add [`tauri.beta.conf.json`](../src-tauri/tauri.beta.conf.json)
  via `tauri build --config …`, which swaps the endpoint to the beta manifest.
  The release workflow applies this automatically for any tag with a
  pre-release suffix (see below).

Both channels are signed with the same updater key (see GL-24); only the
endpoint differs.

## Cutting a release

Tags drive [`.github/workflows/release.yml`](../.github/workflows/release.yml).
The tag must equal the app version in all three files
(`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`) — the
preflight fails the release otherwise.

- **Stable:** bump the three files to `X.Y.Z`, tag `vX.Y.Z`. Published as a
  normal release; becomes the `/latest/` target.
- **Beta:** bump the three files to `X.Y.Z-beta.N`, tag `vX.Y.Z-beta.N`.
  Published as a GitHub **pre-release** (so `/latest/` ignores it), built with
  the beta endpoint.

The tag's pre-release suffix (a `-` after `X.Y.Z`) is what the workflow keys on:
it flips `prerelease: true` and appends the beta `--config`.

## The rolling beta manifest

After **every** release, the `publish-beta-manifest` job copies that release's
`latest.json` onto the fixed `beta` release, giving the beta channel a stable
URL that `/latest/` can't provide for pre-releases. The `beta` release hosts
only the manifest — its artifact URLs point back at the versioned releases.

It runs for stable tags too, on purpose: the beta channel tracks the newest
build of **any** type, so once a stable ships and no newer beta exists, a beta
tester is offered the stable next (`0.2.0 > 0.2.0-beta.x`) and graduates off the
beta channel. The updater only moves forward, so a chronologically older
manifest entry never downgrades anyone.

## Not yet implemented

An in-app "receive beta updates" toggle (switch channels without reinstalling)
would need a runtime `UpdaterBuilder::endpoints()` override driven by a stored
preference. Today the channel is fixed by which build you install.
