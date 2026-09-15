## Why

`docs-site` is pinned to `@cloudflare/nimbus-docs ~0.12.0` (PR #431) because Dependabot #428's
bump to 0.13.1 turned Docs CI red on `latest`. 0.x minors are breaking, and the pin plus a
Dependabot `ignore` for nimbus-docs minor bumps only buys time: every further release widens the
gap, and the site misses framework fixes until someone migrates on purpose. No Jira issue exists.

## What Changes

- Bump `@cloudflare/nimbus-docs` in `docs-site/package.json` from `~0.12.0` to `^0.13.1` and
  refresh `docs-site/bun.lock`.
- Fix `src/content/docs/getting-started/install.mdx`: the 0.13 authored-link normalizer re-parses
  JSX children (the `<Tabs>` block) as TSX and fails with "ambiguous JSX range" on the
  `<version>` placeholder inside fenced code. Use one non-JSX placeholder across the page
  (including the table above the tabs).
- Rewrite `src/pages/llms-full.txt.ts`: **BREAKING (framework)** `renderCorpusMarkdown` was
  removed, and its replacement `renderLlmsFullMarkdown` refuses `<Render>` partials at runtime.
  Serve the prepared full-document artifact from `@cloudflare/nimbus-docs/build` instead.
- Move `src/pages/[...slug]/index.md.ts` (currently `renderEntryAsMarkdown`) onto the prepared
  markdown artifacts, because it throws on the same `<Render>` partial in `install.mdx`. Move
  `[...slug]/index.mdx.ts` onto the prepared `source` surface only if the build shows it breaks.
- Leave `llms.txt.ts` and `[section]/llms.txt.ts` on `getIndexedTopLevel` (still exported in
  0.13.1) unless the build proves otherwise.
- Remove the nimbus-docs `ignore` block from `.github/dependabot.yml` that #431 added.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. `skip_specs: true`: this is a docs-site tooling migration. The published docs pages, the
`.md`/`.mdx` page mirrors and the `llms*.txt` routes keep their URLs and content. No app
(Rust/frontend/IPC) behavior changes, and no `openspec/specs/` capability covers the docs site.

## Non-goals

- No docs content rewrite beyond the `<version>` placeholder.
- No change to routes, URL shapes, sidebar, search, OG images, or the Cloudflare deploy.
- No adoption of other 0.13 features (per-version corpora, request rendering, API reference
  collections).
- No change to the GitLane app, its `package.json`, or the root `bun.lock`.

## Impact

- Process: docs-only (`docs-site/`), plus `.github/dependabot.yml`.
- Files: `docs-site/package.json`, `docs-site/bun.lock`, `install.mdx`, `src/pages/llms-full.txt.ts`,
  `src/pages/[...slug]/index.md.ts`, maybe `src/pages/[...slug]/index.mdx.ts`, `.github/dependabot.yml`.
- CI: `Docs / Lint + build` (`lint:docs`, `typecheck`, `build`) must pass; the Cloudflare deploy
  on `latest` publishes the result.
- Secrets/auth/IPC: none. No tokens, no IPC, no Tauri plugin or CSP change.
- Pattern to copy: nimbus 0.13's own contract for the starter routes (`renderLlmsFullMarkdown`
  docs in `dist/runtime.d.ts`; `getPrepared*` helpers in `dist/build.d.ts`). There is no in-repo
  precedent to copy.
