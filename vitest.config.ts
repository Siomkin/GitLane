/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: false,
  },
});
