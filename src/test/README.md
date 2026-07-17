# Frontend test harness

Vitest + Testing Library. Config: [`vitest.config.ts`](../../vitest.config.ts). Tests
live next to the code as `*.test.ts` / `*.test.tsx`.

The suite is split into two Vitest projects because creating a jsdom world per test
file was the single largest cost of the run:

- **`node`** — every `*.test.ts` not listed in the config's `JSDOM_TEST_TS`: pure
  logic, no DOM. Setup: [`setup.node.ts`](./setup.node.ts) (just the in-memory
  `localStorage` shim from [`local-storage.ts`](./local-storage.ts)).
- **`jsdom`** — every `*.test.tsx`, plus the `JSDOM_TEST_TS` allowlist of `.test.ts`
  files that genuinely need a DOM (real events, `renderHook`, `window`/`document`,
  or `useUi.persist` — zustand's default persist storage reads
  `window.localStorage`). Setup: [`setup.ts`](./setup.ts) (jest-dom matchers, RTL
  `cleanup`, the same `localStorage` shim).

A `.test.ts` file that starts needing the DOM usually fails loudly in the node
project (`document is not defined`, missing jest-dom matchers): add it to
`JSDOM_TEST_TS`, or rename it `.test.tsx` if it gained a render. The exception is
source code behind a `typeof window !== "undefined"`-style guard (or zustand's
persist, which needs `window.localStorage`): in node it silently takes the
fallback branch instead of failing. A node test asserting a browser-only branch
must stub the global explicitly (as `commitAgentImages.test.ts` stubs `Image`) or
live on the jsdom list — persist/rehydration assertions belong in `ui.test.ts`.

## Mocking the IPC boundary (`invoke`)

`lib/api` is the only code that touches Tauri — it calls `@tauri-apps/api/core`'s
`invoke`. To run stores/components that hit the backend headlessly, mock `invoke`
**inline, per test file**, with the canonical Vitest hoisted pattern:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// `vi.mock` is hoisted above the imports below; `vi.hoisted` makes `invokeMock`
// exist in time to be referenced by the factory.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

// Import the code under test *after* the mock is declared.
import { usePulls } from "@/store/pulls";

beforeEach(() => invokeMock.mockReset());

it("drives a backend failure", async () => {
  invokeMock.mockRejectedValueOnce("boom");
  // … exercise the store/component, then assert on its state.
});
```

`invokeMock` is a normal `vi.fn()` — queue results with `.mockResolvedValueOnce(...)` /
`.mockRejectedValueOnce(...)`, or dispatch on the command name (the first arg) via
`.mockImplementation((cmd) => …)`. See [`store/pulls.test.ts`](../store/pulls.test.ts)
for a worked example.

> Keep this inline. A shared re-importable helper that `export`s a `vi.hoisted`
> mock does **not** survive Vitest's per-file hoisting (it throws
> `Cannot export hoisted variable` and depends on fragile import ordering), which
> is why there's no `invoke-mock.ts` module.

Many components don't need this at all — they render from store state set directly
(e.g. `useRepo.setState({ … })`), no `invoke` involved.
