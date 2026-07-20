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
**The tag alone carries the version** (GL-288): the checked-in manifests
(`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
`package.json`) are *not* bumped per release — each build leg stamps the tag's
version into them in its own checkout before building, so no bump commit or PR
is needed. The version recorded in the tree is stale by design (it only shows in
dev builds) and never names a release; a `workflow_dispatch` run must therefore
pass the tag explicitly. Release tags must be created from commits that are
already reachable from `latest`; `develop` and `staging` are not release
sources. What the release ships per platform, and which install channels exist
or are planned, is recorded in [`distribution.md`](distribution.md).
Release tags must exist on `origin` before the workflow starts. The active
repository tag ruleset allows new `v*` tags but blocks updating or deleting them;
the workflow revalidates the remote tag against the pinned build commit and never
creates a tag itself.

- **Stable:** tag `vX.Y.Z` on a commit reachable from `latest`. Published as a
  normal release; becomes the `/latest/` target.
- **Beta:** tag `vX.Y.Z-beta.N`. Published as a GitHub **pre-release** (so
  `/latest/` ignores it), built with the beta endpoint.

The tag's pre-release suffix (a `-` after `X.Y.Z`) is what the workflow keys on:
it flips `prerelease: true` and appends the beta `--config`.

Supported tag shapes are `vX.Y.Z` and `vX.Y.Z-<suffix>`, where `<suffix>` is
dot-separated alphanumerics — e.g. `-beta.1`, `-rc.2`. The preflight regex does
**not** allow extra hyphens inside the suffix (`v1.0.0-alpha-beta` is rejected),
so stick to the `-beta.N` / `-rc.N` convention.

## The rolling beta manifest

After **every** release, the `publish-beta-manifest` job copies that release's
`latest.json` onto the fixed `beta` release, giving the beta channel a stable
URL that `/latest/` can't provide for pre-releases. The `beta` release hosts
only the manifest — its artifact URLs point back at the versioned releases.

It runs for stable tags too, on purpose, so beta testers can graduate. The
manifest is set to the **most recently published** release, whatever its type —
it tracks *last-published*, not *highest-semver*. In the normal case where
versions ship in increasing order the beta channel therefore always points at
the newest build, and when a stable ships after the last beta, testers are
offered it (`0.2.0 > 0.2.0-beta.x`) and move to stable.

The updater never downgrades, so last-published is safe but has one edge: if you
publish an **out-of-order lower** version — say a `v0.2.1` stable hotfix after a
higher `v0.3.0-beta.1` — the manifest points at the lower version and testers on
the higher pre-release see no update until the next **higher** release rolls it
forward. Avoid shipping a lower tag after a higher pre-release, or re-publish the
higher one via `workflow_dispatch`: enter its tag, enable **manifest only**, and
run the workflow. That path requires an already-public release, validates the
manifest version and all four signed platform entries, and updates only the
rolling `beta` release — it does not rebuild or mutate the versioned release.

## Operational notes

- **A failed platform leg does not roll the beta manifest.** `publish-beta-manifest`
  depends on the whole `release-app` matrix succeeding, so if one platform fails,
  the beta channel keeps its previous (complete) manifest rather than publishing a
  partial one. Fix the cause, then re-run the failed job(s) from that Actions run
  (you can't re-push an existing tag; use GitHub's **Re-run failed jobs** for a
  failed build). Use the manifest-only dispatch only after a versioned release
  is already public and you need to restore its manifest without rebuilding.
- **A transient `gh` failure** in the roll step leaves the manifest stale, with a
  red workflow step as the only signal; re-run that job to recover.

### Verifying the first beta

After tagging `vX.Y.Z-beta.N`:

1. All four matrix legs succeed with `--config …/tauri.beta.conf.json` — in
   particular the **Windows** leg (its `--config` path mixes `\` and `/`, which
   Windows tolerates, but it's worth eyeballing the first time).
2. `releases/download/beta/latest.json` exists and its asset URLs resolve.
3. A freshly installed beta build's update check hits the beta endpoint, not
   `/latest/`.
4. After a later stable `vX.Y.Z`, a tester on `X.Y.Z-beta.N` is offered `X.Y.Z`.

## In-app channel toggle (GL-154)

Settings → About has a **"Receive beta updates"** toggle that switches the
update channel *without reinstalling*. The JS `@tauri-apps/plugin-updater`
`check()` can't override endpoints at runtime, so the toggle drives a small Rust
command (`updater::check_update_on_channel`) that rebuilds the updater via
`webview.updater_builder()` and overrides `.endpoints()` **explicitly for the
selected channel** — stable `/latest/` when off, the beta manifest when on. It
does *not* fall back to the build's baked-in default: that default differs per
build (a beta build bakes the beta manifest via `tauri.beta.conf.json`), so
relying on it would leave a beta install stuck on beta after the user turned the
toggle off. Because only `.endpoints()` is overridden, `updater_builder()`
retains the config's signing **pubkey**, so signature verification stays on for
both channels; the checked `Update` is parked in the webview resource table so
the plugin's own download/install path drives it unchanged.

The preference (`betaUpdates` in `src/store/ui.ts`, persisted) **defaults on**
while no stable release exists — the stable `/latest/` endpoint can't resolve
against pre-releases, and it's self-correcting: `publish-beta-manifest` rolls
the beta manifest forward to a stable build once one ships (`0.2.0 >
0.2.0-beta.x`), so a beta-channel user is offered stable automatically. Flip the
default to off once stable is the primary channel.
