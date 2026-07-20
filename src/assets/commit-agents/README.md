# Commit agent icons

These SVGs are bundled by Vite and decoded locally by the graph canvas. The app
never resolves them from a network URL at runtime.

- `claude.svg`, `cursor.svg`, and `copilot.svg` come from `simple-icons@16`.
- `codex.svg` uses the OpenAI mark from `simple-icons@15` because that major
  still publishes the mark and Simple Icons has no separate Codex glyph.
- `dependabot.svg` reuses GitLane's own GitHub mark (see `GitHubIcon` in
  `src/components/ui/icons.tsx`): Simple Icons has no Dependabot glyph, and
  Dependabot is a GitHub product.

Simple Icons is distributed under CC0-1.0. Brand names and marks remain subject
to their owners' trademark policies.
