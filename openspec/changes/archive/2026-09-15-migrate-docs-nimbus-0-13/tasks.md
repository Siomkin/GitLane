## 1. Baseline

- [x] 1.1 On a branch off `latest` (still pinned `~0.12.0`), run `bun install --frozen-lockfile && bun run build` in `docs-site/` and copy `dist/llms-full.txt`, `dist/llms.txt`, and every `dist/**/index.md` to a scratch baseline folder; verify the copies exist and `llms-full.txt` is non-empty

## 2. Dependency bump and spike

- [x] 2.1 Set `@cloudflare/nimbus-docs` to `^0.13.1` in `docs-site/package.json`, run `bun install`, then confirm `bun install --frozen-lockfile` passes and `node_modules/@cloudflare/nimbus-docs/package.json` reports 0.13.x
- [x] 2.2 Spike the prepared-artifact path: temporarily log `getPreparedLlmsArtifact({ scope: "site", surface: "full" })` and one `getPreparedMarkdownArtifact({ collection: "docs", id: "getting-started/install", surface: "markdown" })` from a prerendered route during `bun run build`. Verify both resolve, the install artifact contains the expanded first-launch-warning text, and record whether `body` or `content` is the frontmatter-free markdown. If artifacts are missing, switch to the fallback in design.md Decision 1 before continuing

## 3. Content and routes

- [x] 3.1 Replace every `<version>` in `docs-site/src/content/docs/getting-started/install.mdx` (table and `<Tabs>` code fences) with `X.Y.Z`; verify `grep -n "<version>"` on the file returns nothing and `bun run typecheck` no longer reports "ambiguous JSX range"
- [x] 3.2 Rewrite `docs-site/src/pages/llms-full.txt.ts` to return `getPreparedLlmsArtifact({ scope: "site", surface: "full" })` (`body`, `Content-Type` from `mediaType`) via `@cloudflare/nimbus-docs/build`; verify `bun run typecheck` reports 0 errors and the build emits `dist/llms-full.txt`
- [x] 3.3 In `docs-site/src/pages/[...slug]/index.md.ts`, add the prepared markdown reference to each static path's props and replace `renderEntryAsMarkdown(entry)` with the prepared artifact's markdown field found in 2.2, keeping the existing frontmatter, index pointer and `Source:` lines; verify the build emits `dist/getting-started/install/index.md` containing the first-launch-warning text
- [x] 3.4 Run `bun run build`; if `[...slug]/index.mdx.ts`, `llms.txt.ts`, `[section]/llms.txt.ts` or `og/*` now fail, migrate only the failing route to its prepared helper (`source` surface / `getPreparedLlmsStaticPaths`); verify `bun run build` exits 0

## 4. Parity and config

- [x] 4.1 Diff the new `dist/llms-full.txt`, `dist/llms.txt` and `dist/**/index.md` against the 1.1 baseline; verify the only differences are the `X.Y.Z` placeholder, the expanded partial, and framework formatting changes, each noted in the PR description
- [x] 4.2 Remove the `@cloudflare/nimbus-docs` `ignore` block (and its comment) from `.github/dependabot.yml`; verify `grep -n nimbus .github/dependabot.yml` returns nothing and the YAML still parses (`ruby -ryaml -e 'YAML.load_file(".github/dependabot.yml")'`)

## 5. Definition of done

- [x] 5.1 In `docs-site/`, run `bun install --frozen-lockfile`, `bun run lint:docs`, `bun run typecheck` and `bun run build`; verify all exit 0 (app checks such as `bunx tsc --noEmit`, cargo and `bun run sizes` don't apply: no app files change)
- [x] 5.2 Open the PR against `latest`; verify `Docs / Lint + build` is green, and after merge spot-check `/llms-full.txt` and `/getting-started/install/index.md` on the deployed site
  - Done: #432 merged as e8e5beec with every check green, including `Docs / Lint + build` on `latest`.
  - Deferred: the docs site deploys only on a `v*` tag or a manual `workflow_dispatch`, so on 2026-09-15 docs.gitlane.space still served the 0.12 build. Spot-check both pages (expect `X.Y.Z`, and the first-launch warning in `install/index.md`) after the next release deploy.
