/// <reference types="vitest/config" />
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// *.test.ts files that genuinely need a DOM (dispatch real events, drive
// hooks through renderHook, read window/document) and therefore run in the
// jsdom project alongside every *.test.tsx. All other *.test.ts files are
// pure logic and run in the much cheaper `node` environment — creating a
// jsdom world per file was the single largest cost of the suite.
//
// A node-project test that starts needing the DOM fails loudly
// ("document is not defined"): add it here, or rename it .test.tsx if it
// gained a render.
const JSDOM_TEST_TS = [
  "src/components/navigation/branch-navigator/useNavigatorSections.test.ts",
  "src/features/conflicts/useConflictResolver.test.ts",
  "src/features/terminal/panes/paneController.test.ts",
  "src/hooks/useBranchRefDrag.test.ts",
  "src/hooks/useLazyDiffs.test.ts",
  "src/hooks/useRepoWatcher.test.ts",
  "src/lib/openExternal.tauri.test.ts",
  "src/lib/openExternal.test.ts",
  "src/store/accounts.test.ts",
  "src/store/accountsMigrations.test.ts",
  "src/store/accountsStorage.test.ts",
  "src/store/identities.test.ts",
  "src/store/notifications.test.ts",
  "src/store/providerToken.test.ts",
  "src/store/repo.test.ts",
  "src/store/repoMissing.test.ts",
  "src/store/repoSession.test.ts",
  "src/store/repoWorktreeFallback.test.ts",
  "src/store/repoWriteActions.test.ts",
  // Tests useUi.persist: zustand's default persist storage is
  // `createJSONStorage(() => window.localStorage)`, so without a `window` the
  // middleware silently runs storage-less and never attaches the persist API.
  "src/store/ui.test.ts",
];

// Dedicated test config. When this file exists Vitest ignores `vite.config.ts`
// (no auto-merge), so the `@` alias + React transform are re-declared here to
// keep test-time module resolution identical to the app's.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror vite.config.ts's `@` → src alias so imports resolve the same way.
    // @ts-expect-error process is a nodejs global
    alias: { "@": `${process.cwd()}/src` },
  },
  test: {
    css: false,
    // The self-hosted CI box runs several jobs concurrently; under contention a
    // render+waitFor test can blow the 5s default even though everything is
    // mocked (seen with ReviewWorkspace's "show full diff" test). A hung test
    // still fails — just after 15s instead of 5.
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          setupFiles: ["./src/test/setup.node.ts"],
          include: ["src/**/*.{test,spec}.ts"],
          exclude: [...configDefaults.exclude, ...JSDOM_TEST_TS],
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.{test,spec}.tsx", ...JSDOM_TEST_TS],
        },
      },
    ],
  },
});
