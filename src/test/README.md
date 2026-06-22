# Frontend test harness

Vitest + Testing Library (jsdom). Config: [`vitest.config.ts`](../../vitest.config.ts);
global setup: [`setup.ts`](./setup.ts) (jest-dom matchers, RTL `cleanup`, an in-memory
`localStorage` shim for the persisted `store/ui`). Tests live next to the code as
`*.test.ts` / `*.test.tsx`.

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
import { usePulls } from "../store/pulls";

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
