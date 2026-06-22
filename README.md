# GitLane

A visual git client for macOS — a lightweight, GitKraken-style commit tree with
drag-and-drop branch operations. Built on **Tauri 2** (Rust core) + **React/TypeScript**.

## Stack

- **Shell:** Tauri 2 (native macOS window, ~10 MB)
- **Frontend:** React 19 + TypeScript + Vite, Canvas-rendered commit graph, Zustand state
- **Git reads:** [`git2`](https://docs.rs/git2) (libgit2) — log, refs, branches (network features disabled)
- **Git writes:** shell out to the real `git` binary — honours hooks, credentials, config, conflicts
- **GitHub:** provider boundary backed by the GitHub CLI (`gh`) by default; tokens stay in Rust and never cross IPC
- **Other forges:** auth-status guidance only for GitLab, Bitbucket, Azure DevOps, Gitea, and Forgejo

## Architecture

```
src/                     # React frontend
  lib/
    api/                 # typed invoke() wrappers → Rust (git, github, terminal; merged in index.ts)
    cn.ts paths.ts highlight.ts prs.ts palette.ts ui.ts   # pure helpers + tokens
  store/                 # Zustand, split by concern: repo · pulls · accounts · ui · selection
  features/              # graph (GraphLayer canvas + palette), changes, review, pull-requests, terminal
  components/
    ui/                  # reusable, domain-free primitives
    chrome/              # window chrome, toolbar, overlays
    navigation/          # branch navigator + PR list panel
  hooks/                 # useLazyDiffs, useDismiss, useRepoWatcher

src-tauri/src/
  auth_providers.rs      # auth-only status probes for non-GitHub forges
  lib.rs                 # Tauri commands (IPC boundary) + generate_handler! registration
  git/
    forge.rs             # known remote forge detection (GitHub, GitLab, Bitbucket, Azure, Gitea, Forgejo)
    types.rs             # serde structs shared with the frontend (camelCase)
    read.rs status.rs    # libgit2 reads: summary, branches, working-tree status, diffs
    graph.rs             # DAG → lane (column) layout algorithm
    write.rs             # checkout/branch/merge/rebase/reset/stage/commit/stash via `git` CLI
    github/              # provider boundary + default `gh` provider
      mod.rs             #   facade: stable `git::github::*` API through GithubService
      domain.rs          #   provider-neutral context, account refs, typed internal errors
      service.rs         #   GithubService + GithubProvider contract
      gh_provider.rs     #   default provider that delegates to the split gh modules
      cli.rs             #   the single `gh` subprocess site (run_gh); accounts/tokens/repo identity
      dto.rs             #   private gh/GraphQL response shapes + domain conversions
      prs.rs             #   PR reads/writes (`gh pr …`) + argument builders
      threads.rs         #   review-thread GraphQL (resolve/unresolve)
      diff.rs            #   PR patch fetch + unified-diff parser
  watcher.rs             # filesystem watcher → repo-changed event
```

### How the graph is laid out

`git/graph.rs` walks the DAG topologically and assigns each commit a **lane**
(column) using a reservation algorithm: every lane holds the id of the parent
commit it's waiting to render. The first parent continues a commit's lane;
merges branch into fresh lanes. The frontend just paints the resulting
`(row, lane, color)` coordinates — no layout logic lives in JS.

## Develop

Prerequisites:

- `bun`
- Rust toolchain
- `git`
- `gh` 2.95.0 or newer for GitHub/PR features

```bash
bun install
bun run tauri dev      # launch the app (hot-reloads frontend + Rust)
```

Other:

```bash
bun run build          # tsc + vite production build
(cd src-tauri && cargo check)
```

GitLane currently validates `gh` 2.95.0 as the minimum supported GitHub CLI baseline:

| Capability | Probe |
| --- | --- |
| Version | `gh version` |
| Host-aware account discovery | `gh auth status --json hosts` |
| Host/user token resolution | `gh auth token --hostname <host> --user <login>` |
| PR patches | `gh pr diff --patch --color never` |
| GraphQL | `gh api graphql` |

## Status — milestone 1

- [x] Open a repository (native folder picker) and render the commit graph
- [x] Branch sidebar (local + remote); double-click a local branch to checkout
- [x] Commit details panel
- [x] Write commands wired in Rust (checkout / branch / merge / rebase / reset)
- [x] Drag-and-drop branch → merge / rebase / reset action menu
- [x] Diff view + staging / commit
- [x] Pull-request browsing across multiple `gh` accounts
- [ ] Graph virtualization for very large repos

## License

GitLane is licensed under the **GNU General Public License v3.0 or later**
(`GPL-3.0-or-later`) — see [LICENSE](LICENSE). This applies to the
software in this repository, including the bundled app icons and other shipped
assets, unless a file states a different license.

In short: you may use, study, modify, and redistribute this software, but any
distributed derivative work must also be released under the GPL with its
complete corresponding source. This keeps GitLane and everything built on it
free and open.

Third-party dependencies retain their own licenses. Check `package.json`,
`bun.lock`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` for the exact
dependency set before distributing a build.

© 2026 Siomkin Alexander. The GitLane name and logo may be protected as
trademarks; the GPL grants copyright permissions, not trademark rights.
