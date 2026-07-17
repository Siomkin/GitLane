// Vitest setup for the `jsdom` project — runs before each DOM test file.
//
// 1. Registers jest-dom matchers on Vitest's `expect` (the `/vitest` entry also
//    augments the type, so `toBeInTheDocument()` etc. typecheck without globals).
// 2. Unmounts React trees rendered with `@testing-library/react` after each test
//    so tests stay isolated even with `globals: false`.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { installLocalStorage } from "./local-storage";

// TanStack Virtual uses a debounced timer fallback when native `scrollend`
// support is absent. jsdom tears down `window` after each test file, so a
// pending fallback can fire after cleanup and surface as an unrelated
// `window is not defined` unhandled error. Mark the event as supported so
// virtualized tests follow the event-driven path instead.
if (typeof window !== "undefined" && !("onscrollend" in window)) {
  Object.defineProperty(window, "onscrollend", {
    value: null,
    configurable: true,
    writable: true,
  });
}

// In-memory localStorage for the persisted Zustand store — see local-storage.ts.
installLocalStorage();

afterEach(() => {
  cleanup();
});
