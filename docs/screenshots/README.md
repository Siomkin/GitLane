# README screenshots

These images are embedded in the top-level [README](../../README.md).

> **Current status:** all eleven PNGs are full-window Retina captures (2560×1600)
> in a 1280×800 window, on a fictional demo repository with fictional pull
> requests. `drag-drop-menu.png` shows the v2.8.1 release (the redesigned drop
> menu); the other ten show a v2.7.0 dev build. Recapture with the guidelines
> below when the UI changes.

Capture guidelines: use a tidy demo repository (no client/private code or real
people's names; a surname like "Example" can't match anyone), a 1280×800 window,
and native Retina (2×) PNG output. Don't downscale: GitHub stretches narrower
images to the README column, which blurs them on Retina screens. Show only the
app window, without the desktop behind it. Light theme, except the `-dark` files.

| File | What to show |
| --- | --- |
| `hero-graph.png` | The History workspace on a repo with several colored branch lanes and a couple of merges — the signature swimlane graph. Full app window. |
| `hero-graph-dark.png` | The same History workspace in the dark theme. |
| `drag-drop-menu.png` | Mid drag-and-drop: one branch ref dropped onto another with the action menu open (the Drag / Onto header, then Merge / Rebase / Reset with their descriptions). |
| `changes-staging.png` | The Changes workspace in its Staging area view with a few staged + unstaged files and a diff visible (unified or split). |
| `changes-staging-dark.png` | The same Changes workspace in the dark theme. |
| `include-review.png` | The Changes workspace in its Include view: a file whose differences each show a ticked checkbox. |
| `pull-requests.png` | PRs mode: the PR list panel plus one PR open in detail. |
| `history-search.png` | Quick search active with a query and match count: matched commits at full strength (substring marked), everything else dimmed, results panel open. |
| `worktree-open.png` | The main checkout, with a branch pill carrying the worktree badge and its menu open on **Open worktree** — the "another worktree holds this branch" state. |
| `worktree-handoff.png` | The app with a linked worktree open: the toolbar's back-to-main cluster and worktree chip, plus a branch menu's **Worktree** submenu expanded (path, Check out here, Copy worktree path, Hand off to…). Keep the demo repo at a short path, or the path stretches the menu. |
| `conflict-resolution.png` | Mid-merge conflict workspace: the "Merge in progress" banner, side-by-side ours/theirs panes with per-line checkboxes, and the merged Output pane. Use a tidy demo repo with a real conflict. |
