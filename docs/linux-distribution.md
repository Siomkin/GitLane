# Linux distribution decision record

Jira: GL-83

How GitLane ships on Linux, which install path we recommend, and the decision
on package-manager channels (Flathub / AUR / distro repos). Read this before
adding a distribution channel or changing the Linux bundle targets.

## Current state

Every release ships three Linux artifacts, built by the self-hosted
`linux-gitlane` runner (`bundle.targets: "all"` in
[`tauri.conf.json`](../src-tauri/tauri.conf.json)):

| Asset | Format | What the user gets |
| --- | --- | --- |
| `GitLane-<version>-linux-deb.deb` | Debian package | Normal install: app-menu entry, icon, uninstall via apt/dpkg. **Recommended.** |
| `GitLane-<version>-linux-rpm.rpm` | RPM package | Same, via dnf/rpm. **Recommended.** |
| `GitLane-<version>-linux-appimage.AppImage` | AppImage | Portable single file. No exec bit after download (browsers strip it — inherent to bare AppImage distribution, not a build bug) and no desktop integration without a helper (Gear Lever / AppImageLauncher). Fallback only. |

The `.sig` files are minisign signatures for the built-in Tauri updater
(GL-24), not user-facing downloads. Per-format install instructions live in
the [README install section](../README.md#linux-pick-a-package); the release
page body links there.

## Channel decisions

| Channel | Decision | Rationale |
| --- | --- | --- |
| **AUR** (`gitlane-bin`) | **Publish** — follow-up ticket | Cheap: a PKGBUILD that repackages the release `.deb`. Covers Arch users with one command; no extra build infrastructure. Stable tags only. |
| **Flathub** | **Spike first** — follow-up ticket | The channel users most expect (one-click install + automatic updates on Fedora/Ubuntu/SteamOS), but a git client is unusually host-dependent for a Flatpak — see below. Don't commit until the spike answers go/no-go. |
| **apt repo / Fedora copr** | **Not now** | Standing repo infrastructure (hosting, GPG signing, per-distro maintenance) isn't justified at current scale; the direct `.deb`/`.rpm` download already serves those users. Revisit if install friction shows up in issues. |

### Why Flathub needs a spike, not a manifest

- **Host subprocesses.** Every git write shells out to the host `git` binary
  (hooks, credential helpers, signing — the core design, see CLAUDE.md), and
  GitHub features shell out to host `gh`. Inside the sandbox that means
  `flatpak-spawn --host` for every spawn site (`git/write/cli.rs`,
  `git/github/cli.rs`, gpg probes), which must preserve stdin piping,
  `GH_TOKEN` env passing, and exit codes.
- **Filesystem access.** GitLane opens arbitrary repo paths and watches them
  (inotify) — realistically `--filesystem=host`, which Flathub review treats
  as a red flag unless justified.
- **Updater ownership.** Flathub owns updates; the built-in Tauri updater must
  be disabled in the Flatpak build (build-time config or `FLATPAK_ID`
  detection). The beta channel would not exist on Flathub.

### AUR sketch (for the follow-up)

`gitlane-bin`: PKGBUILD downloads the release `.deb`, extracts with `bsdtar`,
installs app + desktop entry + icons; `provides=(gitlane)`,
`conflicts=(gitlane)`; runtime deps `webkit2gtk-4.1`, `gtk3`, `git`, optional
`github-cli`. Manual `pkgver` bump per stable release at first; automating the
bump from `release.yml` is a later nicety.
