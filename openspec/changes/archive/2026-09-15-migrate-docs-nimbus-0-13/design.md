## Context

See proposal.md for why. What we know about the site on 0.13.1:

- `astro.config.ts` registers `nimbus(nimbusConfig, …)`. The `@cloudflare/nimbus-docs/build`
  helpers need that integration (they throw "build helpers require the Nimbus Astro integration"
  without it).
- A scripted check of every named import from `@cloudflare/nimbus-docs*` in `docs-site/src`
  against 0.13.1's type exports finds one removal: `renderCorpusMarkdown` (`llms-full.txt.ts`).
  `getIndexedEntries`, `getIndexedTopLevel`, `renderEntryAsMarkdown`, the `client`, `types`,
  `content` and `lib/pkgm` imports all still exist.
- Present but changed: `renderEntryAsMarkdown` / `renderLlmsFullMarkdown` throw on `<Render>`
  partials at runtime. `install.mdx` is the only page using `<Render>`
  (`first-launch-warning`), so every route that renders that page's body breaks:
  `llms-full.txt` (build failed here first) and `[...slug]/index.md`.
- Replacements in `@cloudflare/nimbus-docs/build`:
  - `getPreparedLlmsArtifact({ scope: "site", surface: "full" | "index" })` and
    `getPreparedLlmsStaticPaths()` (section indexes, `params: { section }`) →
    `{ digest, mediaType, body }`.
  - `getPreparedMarkdownStaticPaths({ collection, surface: "markdown" | "source" })` →
    `params: { slug }`, `props: { artifact }`; `getPreparedMarkdownArtifact(ref)` →
    `{ digest, mediaType, body, content }`.
- The authored-link normalizer re-parses JSX children as TSX. A `<version>` inside fenced code
  in `<Tabs>` looks like a JSX element and breaks the range lookup. Replacing it with `X.Y.Z` was
  verified to clear that error on 0.13.1.

## Goals / Non-Goals

**Goals:**
- `bun run lint:docs`, `typecheck` and `build` pass on nimbus-docs 0.13.x in CI.
- Existing route URLs keep working. `llms-full.txt` and `/<slug>/index.md` output matches
  today's apart from reviewed, explainable differences.

**Non-Goals:**
- Rebuilding routes that still build on 0.13 (`llms.txt`, `[section]/llms.txt`,
  `[...slug]/index.mdx`, `og/*`) just to match the framework's newest starter.

## Decisions

1. **Serve the llms-full.txt and page `.md` routes from build-time prepared artifacts,
   instead of removing `<Render>` from `install.mdx`.**
   The 0.13 doc comment says sites should prepare artifacts at build time rather than compose
   runtime renderers, which don't carry partial context. Following that keeps partials usable
   on any page.
   - Alternative, the *fallback*: inline the `first-launch-warning` partial into `install.mdx`
     and call `renderLlmsFullMarkdown({ base })` in `llms-full.txt.ts`. It's smaller, but it bans
     partials from every page that feeds a markdown route, a trap for the next author. Use it
     only if task 2.1 shows prepared artifacts aren't produced for this site's config.

2. **`llms-full.txt.ts` returns `getPreparedLlmsArtifact({ scope: "site", surface: "full" })`
   verbatim**, with `Content-Type` taken from `artifact.mediaType`. It keeps `prerender = true`
   and the header comment.

3. **`[...slug]/index.md.ts` keeps its own frontmatter and index-pointer header and swaps only
   the body.** `getStaticPaths` stays driven by `getIndexedEntries()`, so it keeps the title,
   description, social image, version and `sourceUrl` metadata. Each path also carries the
   prepared reference `{ collection: "docs", id: entry.id, surface: "markdown" }`, and `GET` uses
   `(await getPreparedMarkdownArtifact(ref)).body` where it used `renderEntryAsMarkdown(entry)`.
   - Alternative: drive paths from `getPreparedMarkdownStaticPaths` and return `artifact.content`
     verbatim. That's less code, but it changes the published header (loses the `/llms.txt`
     pointer and `Source:` line) unless `content` happens to match. Take it only if the parity
     diff in 3.3 shows `content` is equivalent.
   - Which of `body`/`content` holds the frontmatter-free markdown is settled empirically in 2.1,
     not assumed.

4. **Placeholder `X.Y.Z`** replaces every `<version>` in `install.mdx`, including the table above
   the tabs, so the page uses one placeholder. `{version}` would be parsed as an MDX expression,
   and HTML entities render literally inside code fences.

5. **Drop the Dependabot `ignore`** for `@cloudflare/nimbus-docs` minor bumps in the same change.
   Once the site is on 0.13, grouped minor/patch bumps should flow again. A future breaking
   minor surfaces as a red Dependabot PR, which is the signal we want.

## Risks / Trade-offs

- [Prepared artifact output differs from runtime rendering: heading levels, link
  normalization, partial expansion] → Build on the pinned 0.12 baseline first, save
  `dist/llms-full.txt` and `dist/**/index.md`, then diff against the migrated build. Review
  each difference; the expected ones are the placeholder and the now-expanded partial.
- [Prepared artifacts need integration-side demand/registration that this config doesn't
  trigger] → Task 2.1 checks the manifest before rewriting any routes. If it's empty, fall back
  per Decision 1.
- [0.13.x patch releases change the `build` helper contract again] → `^0.13.1` plus the frozen
  lockfile; Dependabot patch PRs run the same Docs CI.
- [`Docs / Lint + build` isn't a required check on `latest`, which is how #428 merged red] →
  Out of scope here, but the PR description should flag it.

## Migration Plan

1. Land on a branch off `latest`; Docs CI must be green before merge.
2. The merge deploys through the existing Cloudflare job on `latest`. Spot-check `/llms-full.txt`
   and `/getting-started/install/index.md` on the deployed site.
3. Rollback: revert the PR, which restores the `~0.12.0` pin, the old routes and the Dependabot
   ignore together.
