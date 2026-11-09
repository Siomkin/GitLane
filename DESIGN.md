# DESIGN.md

How GitLane's desktop UI is styled. The values live in code, so this file names
where to find them. The enforceable rules are in
[`docs/rules/architecture-rules-react.md`](docs/rules/architecture-rules-react.md).

## Styling

- Tailwind v4 utilities, composed with `cn()` from `src/lib/cn.ts`.
- Use tokens instead of hardcoded colors. Reference them as `var(--text2)` or
  `text-[color:var(--accent)]`.
- Dark mode is class-based: `.dark` on `.gp-root`, read by the `dark:` variant. Do
  not use `prefers-color-scheme`.
- Shared constants such as `focusRing` and `MONO_FONT` are in `src/lib/ui.ts`.

## Tokens

All are CSS variables on `.gp-root` in `src/App.css`: dark values first, with light
overrides under `.gp-root:not(.dark)`. New themed tokens need both.

| Group | Tokens |
| --- | --- |
| Surfaces | `--bg` `--bg2` `--bg3` `--panel` `--elev` `--soft` `--code` |
| Text | `--textBright` `--text` `--text2` `--text3` `--text4` `--muted` |
| Lines | `--border` `--border2` `--border3` `--sep` |
| Controls | `--btnHover` `--menuHover` `--tabActive` `--tabActiveBd` `--chip` `--chipBd` `--pill` |
| Rows | `--hover` `--altRow` `--overlay` |
| Diff | `--hunkBg` `--hunkText` `--numCol` `--signCtx` |
| Loading | `--skelBase` `--skelHi` |
| Status | `--nf-info` `--nf-success` `--nf-warning` `--nf-error` `--nf-neutral`, each with a `-soft` wash |
| Elevation | `--shadow-pop` |

## Color roles

- `--accent` is the one brand color, used for the HEAD badge, primary buttons,
  active tabs, and additions. `--accent-soft` is its wash for selected rows and
  chips. It is green (`#2e9e62`) by default and user-selectable through
  `src/lib/accent.ts`, so never assume green.
- `--theirs` and `--theirs-soft` mark the incoming side of a conflict. The fixed
  fuchsia stays distinct from "ours", which uses the accent.
- Graph geometry and lane colors are in `src/features/graph/palette.ts`; Rust
  assigns each commit's color index.

## Components

- Check `src/components/ui/` before building a control. Use its `Select`,
  `SearchableSelect`, `SegmentedControl`, `Loading`, `Skeleton`, `StatusBadge`, and
  `Resizer` rather than native or one-off versions.
- Those primitives take props only: no store imports and no git domain knowledge.
- Icons are stroke glyphs in `src/components/ui/icons.tsx` that inherit
  `currentColor`.
