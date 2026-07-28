# README screenshots

These images are embedded in the top-level [README](../../README.md).

> **Current status:** all eight PNGs are real window captures (light theme,
> 2x Retina). The original four are GitLane v0.2.0-beta.3 (4024×2384) with the
> GitLane repo itself open; `history-search.png` and `conflict-resolution.png`
> were captured on a v1.5.x dev build (2880×1800, 1440×900 window —
> `conflict-resolution.png` uses a scratch demo repo with a staged merge
> conflict); the two `worktree-*.png` are v1.5.x crops of the graph area rather
> than full windows. Recapture with the guidelines below when the UI changes.

Capture guidelines: use a tidy demo repository (no client/private code or real
account names), the default dark theme, a comfortable window (~1440×900), and
export PNG at 2x (Retina). Crop to the app window without the desktop behind it.

| File | What to show |
| --- | --- |
| `hero-graph.png` | The History workspace on a repo with several colored branch lanes and a couple of merges — the signature swimlane graph. Full app window. |
| `drag-drop-menu.png` | Mid drag-and-drop: one branch ref dropped onto another with the action menu open (Fast-forward / Merge / Rebase / Reset visible). |
| `changes-staging.png` | The Changes workspace with a few staged + unstaged files and a diff visible (unified or split). |
| `pull-requests.png` | PRs mode: the PR list panel plus one PR open in detail with files/checks visible. |
| `history-search.png` | Quick search active with a query and match count: matched commits at full strength (substring marked), everything else dimmed, results panel open. |
| `worktree-open.png` | The main checkout, with a branch pill carrying the worktree badge and its menu open on **Open worktree** — the "another worktree holds this branch" state. |
| `worktree-handoff.png` | The app with a linked worktree open: the toolbar's back-to-main cluster and worktree chip, plus a branch menu's **Worktree** submenu expanded (path, Check out here, Copy worktree path, Hand off to…). |
| `conflict-resolution.png` | Mid-merge conflict workspace: the "Merge in progress" banner, side-by-side ours/theirs panes with per-line checkboxes, the merged Output pane, and a partially resolved file ("1 of 2 conflicts resolved"). Use a tidy demo repo with a staged conflict. |
