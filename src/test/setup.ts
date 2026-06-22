// Vitest setup — runs before each test file.
//
// 1. Registers jest-dom matchers on Vitest's `expect` (the `/vitest` entry also
//    augments the type, so `toBeInTheDocument()` etc. typecheck without globals).
// 2. Unmounts React trees rendered with `@testing-library/react` after each test
//    so tests stay isolated even with `globals: false`.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom + the Node runtime don't expose a usable `localStorage` here, but the
// persisted Zustand store (store/ui) writes to it on every setState. Install a
// minimal in-memory shim so persisted stores work headlessly.
(function installLocalStorage() {
  const existing = (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();
  if (existing && typeof existing.setItem === "function") return;

  const store = new Map<string, string>();
  const mem: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    key: (i) => [...store.keys()][i] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: mem,
    configurable: true,
    writable: true,
  });
})();

afterEach(() => {
  cleanup();
});
