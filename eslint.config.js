// ESLint flat config — encodes the load-bearing architecture invariants from
// docs/rules/ as lint rules (GL-58) so they cannot silently regress. This file
// is the *enforcement* mechanism for the Tier-1 import boundaries; the prose in
// architecture-rules*.md is the rationale. Deliberately narrow: it lints the
// boundaries, not general style (the arrow-vs-function question is settled in
// the docs, not linted — see GL-59).
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Raw IPC lives only in lib/api: forbid importing `invoke` anywhere else. Other
// @tauri-apps/api modules (event/window/app) are unrestricted — only the IPC
// call is boundaried.
const RAW_INVOKE = {
  name: "@tauri-apps/api/core",
  importNames: ["invoke"],
  message:
    "Raw invoke() belongs only in src/lib/api/* — call a typed `api` wrapper from a store action or feature hook instead (architecture-rules.md §1).",
};

// The `api` object (and its per-domain slices) is the IPC value surface. Type
// imports from lib/api are allowed everywhere; the runtime objects are confined
// to the boundary sites (stores, lib/api, documented session/probe hooks).
const API_OBJECTS = {
  group: ["**/lib/api", "**/lib/api/**"],
  importNames: ["api", "gitApi", "githubApi", "providersApi", "terminalApi"],
  allowTypeImports: true,
  message:
    "Import the `api` object only from a store action, lib/api, or a documented session/probe boundary — not ad hoc in UI (architecture-rules-react.md §1).",
};

// components/ui primitives are domain-free: no store, feature, or lib/api imports
// (lib/cn, lib/ui and other plain helpers are fine).
const UI_PURITY = {
  group: ["**/store", "**/store/**", "**/features/**", "**/lib/api", "**/lib/api/**"],
  message:
    "components/ui must stay domain-free: no store, feature, or lib/api imports (architecture-rules-react.md §2).",
};

const restrict = (options) => ({ "no-restricted-imports": ["error", options] });

// A flat config is just an array of config objects; export one directly (the
// `tseslint.config()` helper only adds nested-array flattening we don't need).
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "ds-bundle/**",
      ".design-sync/**",
      ".ds-sync/**",
      ".claude/**",
      "scripts/**",
      "public/**",
      "*.config.{js,ts}",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...restrict({ paths: [RAW_INVOKE], patterns: [API_OBJECTS] }),
      // The codebase already annotates intentional dependency omissions with
      // react-hooks/exhaustive-deps directives; define the rule so those resolve.
      // rules-of-hooks is a hard correctness gate; exhaustive-deps is advisory
      // (warn) so it never blocks CI on a deliberately partial deps array.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Stores own domain data loading: they may import the `api` object, never raw invoke.
  {
    files: ["src/store/**/*.{ts,tsx}"],
    rules: restrict({ paths: [RAW_INVOKE] }),
  },
  // Documented boundary sites that legitimately import the `api` object: the PTY
  // panes manager (imperative xterm/PTY lifecycle) and the action-menu probe
  // (architecture-rules-react.md §1).
  {
    files: ["src/features/terminal/useTerminalPanes.ts", "src/components/chrome/overlays/menus.tsx"],
    rules: restrict({ paths: [RAW_INVOKE] }),
  },
  // components/ui primitives stay domain-free.
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: restrict({ paths: [RAW_INVOKE], patterns: [UI_PURITY] }),
  },
  // lib/api owns the raw IPC surface — both invoke and the api objects originate here.
  {
    files: ["src/lib/api/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
  // Tests mock the boundary and build fixtures; the import invariants don't apply.
  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": "off" },
  },
];
