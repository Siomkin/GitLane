import { defineConfig } from "astro/config";
import icon from "astro-icon";
import tailwindcss from "@tailwindcss/vite";
import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { tableScroll } from "@cloudflare/nimbus-docs/markdown";

const nimbusConfig = defineNimbusConfig({
  // TODO: point this at the real docs origin before the first deploy — it
  // drives canonical URLs, absolute OG image URLs, robots.txt, the sitemap,
  // and every link in /llms.txt.
  site: "https://gitlane.pages.dev",
  title: "GitLane",
  description:
    "A fast, lightweight visual git client for macOS, Windows, and Linux — swimlane commit graph, drag-and-drop branch operations, and pull requests without leaving the app.",
  locale: "en",
  homeLabel: "GitLane docs",
  github: "https://github.com/Siomkin/GitLane",
  editPattern:
    "https://github.com/Siomkin/GitLane/edit/latest/docs-site/src/content/docs/{path}",
  socialImageAlt: "GitLane documentation",
});

export default defineConfig({
  output: "static",
  // Tailwind v4 via its Vite plugin (the integration Astro recommends for
  // Tailwind v4 — replaces the PostCSS plugin, which doesn't build under
  // Astro 7's Vite 8 bundler).
  vite: {
    plugins: [tailwindcss()],
  },
  // Hover-prefetch link targets so full-page navigations feel instant without
  // a client-side router.
  prefetch: {
    prefetchAll: true,
    defaultStrategy: "hover",
  },
  integrations: [
    icon(),
    nimbus(nimbusConfig, {
      // Authoring rules are opt-in by design — your repo, your taste. The
      // two below are the load-bearing pair: frontmatter has to validate
      // against the content schema for the page to render properly, and
      // broken internal links are 404s for your readers. Add the others
      // (heading hierarchy, code-block language, style, etc.) when you're
      // ready to enforce them — see `nimbus-docs lint --help`.
      rules: {
        "nimbus/frontmatter-shape": "error",
        "nimbus/internal-link": "error",
      },
      // Wrap wide tables so they scroll instead of overflowing the page
      // (styled by `.nb-table-scroll` in src/styles/prose.css).
      markdown: {
        hastPlugins: [tableScroll()],
      },
    }),
  ],
});
