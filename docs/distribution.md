# Distribution decision record

Jira: GL-83 (Linux), GL-86 (macOS), GL-87 (Windows)

How GitLane ships on each platform, which install path we recommend, and the
decision on package-manager channels (Flathub / AUR / Homebrew / winget /
distro repos). Read this before adding a distribution channel or changing
bundle targets.

Common to all platforms: the `.sig` files next to release assets are minisign
signatures for the built-in Tauri updater (GL-24), not user-facing downloads.
Per-format install instructions live in the
[README install section](../README.md#install); the release page body links
there. A mirroring install section on gitlane.space is tracked in GL-99.

## Linux

### Current state

Every release ships three Linux artifacts, built by the self-hosted
`linux-gitlane` runner (`bundle.targets: "all"` in
[`tauri.conf.json`](../src-tauri/tauri.conf.json)):

| Asset | Format | What the user gets |
| --- | --- | --- |
| `GitLane-<version>-linux-deb.deb` | Debian package | Normal install: app-menu entry, icon, uninstall via apt/dpkg. **Recommended.** |
| `GitLane-<version>-linux-rpm.rpm` | RPM package | Same, via dnf/rpm. **Recommended.** |
| `GitLane-<version>-linux-appimage.AppImage` | AppImage | Portable single file. No exec bit after download (browsers strip it — inherent to bare AppImage distribution, not a build bug) and no desktop integration without a helper (Gear Lever / AppImageLauncher). Fallback only. |

### Channel decisions

| Channel | Decision | Rationale |
| --- | --- | --- |
| **AUR** (`gitlane-bin`) | **Publish** — GL-94 | Cheap: a PKGBUILD that repackages the release `.deb`. Covers Arch users with one command; no extra build infrastructure. Stable tags only. |
| **Flathub** | **Spike first** — GL-95 | The channel users most expect (one-click install + automatic updates on Fedora/Ubuntu/SteamOS), but a git client is unusually host-dependent for a Flatpak — see below. Don't commit until the spike answers go/no-go. |
| **apt repo / Fedora copr** | **Not now** | Standing repo infrastructure (hosting, GPG signing, per-distro maintenance) isn't justified at current scale; the direct `.deb`/`.rpm` download already serves those users. Revisit if install friction shows up in issues. |

### Why Flathub needs a spike, not a manifest

- **Host subprocesses.** Every git write shells out to the host `git` binary
  (hooks, credential helpers, signing — the core design, see CLAUDE.md), and
  GitHub features shell out to host `gh`. Inside the sandbox that means
  `flatpak-spawn --host` for every spawn site (`git/write/cli.rs`,
  `git/forge/cli.rs`, gpg probes), which must preserve stdin piping,
  `GH_TOKEN` env passing, and exit codes.
- **Filesystem access.** GitLane opens arbitrary repo paths and watches them
  (inotify) — realistically `--filesystem=host`, which Flathub review treats
  as a red flag unless justified.
- **Updater ownership.** Flathub owns updates; the built-in Tauri updater must
  be disabled in the Flatpak build (build-time config or `FLATPAK_ID`
  detection). The beta channel would not exist on Flathub.

### AUR sketch (for GL-94)

`gitlane-bin`: PKGBUILD downloads the release `.deb`, extracts with `bsdtar`,
installs app + desktop entry + icons; `provides=(gitlane)`,
`conflicts=(gitlane)`; runtime deps `webkit2gtk-4.1`, `gtk3`, `git`, optional
`github-cli`. Manual `pkgver` bump per stable release at first; automating the
bump from `release.yml` is a later nicety.

## macOS

### Current state

Two DMGs per release (`macos-arm64`, `macos-x86_64`), built on the self-hosted
Mac mini. Builds are **ad-hoc-signed** (`bundle.macOS.signingIdentity: "-"`)
and **not notarized** — [`release.yml`](../.github/workflows/release.yml)
deliberately leaves the `APPLE_*` secrets unset for the alpha phase (the
wiring is documented inline there). Consequence: a quarantined browser
download fails Gatekeeper — *"GitLane is damaged"* on Apple Silicon,
*"unidentified developer"* on Intel — until the user clears the quarantine
flag (documented in the README). The in-app updater installs without
quarantine, so existing users are unaffected.

### Channel decisions

| Channel | Decision | Rationale |
| --- | --- | --- |
| **Developer ID signing + notarization** | **Do** — GL-96, blocked on Apple Developer Program enrollment (~$99/yr) | Removes the Gatekeeper block entirely; the macOS analog of GL-82. `release.yml` already documents the exact `APPLE_*` secret wiring; drop `signingIdentity: "-"` when it lands. The cert import (`security import`) needs the GUI session the runner already requires for DMG bundling (GL-78) — verify on the mini. |
| **Homebrew cask** (`brew install --cask gitlane`) | **Publish after notarization** — GL-97 (queues behind GL-96) | The de-facto macOS channel for developer tools. Unsigned casks get flagged/rejected in homebrew/cask, so it lands after signing. Set `auto_updates true` so `brew upgrade` doesn't fight the built-in updater. |
| **Mac App Store** | **No** | The App Store sandbox forbids the host-git model (spawning the user's `git`/`gh`, arbitrary filesystem access) — incompatible with GitLane's core design. |

## Windows

### Current state

One NSIS installer per release (`GitLane-<version>-windows-nsis.exe`), built
on GitHub-hosted `windows-latest`. **NSIS only** since GL-78 — the WiX/MSI
target can't encode `-beta.N` versions. The build is **unsigned**, so fresh
downloads hit Defender SmartScreen's "unknown publisher" block; Authenticode
code signing is tracked separately in **GL-82** (this record doesn't duplicate
it). The in-app updater runs the installer without Mark-of-the-Web, so
updates don't retrigger SmartScreen.

### Channel decisions

| Channel | Decision | Rationale |
| --- | --- | --- |
| **winget** (`winget install GitLane`) | **Publish after GL-82** — GL-98 | The de-facto Windows channel; free (manifest PR into microsoft/winget-pkgs), automatable per stable release via the winget-releaser GitHub Action. winget accepts unsigned installers, but validation, Defender scanning, and user trust are much smoother signed — so it queues behind GL-82. |
| **Scoop / Chocolatey** | **Not now** | Community buckets are cheap but each is another manifest to keep current; winget covers the mainstream case. Revisit on demand. |
| **MSI** | **Not now** — revisit for stable tags only if enterprise demand appears | The WiX version limit only bites pre-release identifiers, so a stable-only MSI leg is possible; no demand yet to justify the second installer. |
