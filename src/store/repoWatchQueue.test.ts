import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control the resolution of each IPC call so ordering across the FIFO chain is
// observable. Each call records its name+path and parks on a promise the test
// releases explicitly. Hoisted so the `../lib/api` mock factory (itself hoisted)
// can close over them.
const { calls, pending, apiMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const pending: Array<{ label: string; resolve: () => void; reject: () => void }> = [];
  const deferred = (label: string) => {
    calls.push(label);
    return new Promise<void>((resolve, reject) =>
      pending.push({ label, resolve, reject: () => reject(new Error(label)) }),
    );
  };
  return {
    calls,
    pending,
    apiMock: {
      watchRepo: (path: string) => deferred(`watch:${path}`),
      unwatchRepo: (path: string) => deferred(`unwatch:${path}`),
    },
  };
});

vi.mock("@/lib/api", () => ({ api: apiMock }));

import { unwatchRepo, watchRepo } from "./repoWatchQueue";

/** Let queued microtasks settle (the first link dispatches one tick after it
 * is enqueued, since it chains off a resolved promise). */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

/** Resolve the oldest parked IPC call and let the next link dispatch. */
async function release() {
  pending.shift()?.resolve();
  await tick();
}

describe("repoWatchQueue — per-path FIFO sequencing (GL-125)", () => {
  beforeEach(() => {
    calls.length = 0;
    pending.length = 0;
  });

  // Drain any still-parked IPC so the module's per-path chains tear down between
  // tests. (Each test also uses a distinct path, so a leak can't cross over.)
  afterEach(async () => {
    while (pending.length) await release();
  });

  it("does not dispatch a same-path watch until the prior unwatch resolves", async () => {
    void unwatchRepo("/t1");
    void watchRepo("/t1");
    await tick();
    // Only the first link's IPC has been dispatched; the watch waits its turn.
    expect(calls).toEqual(["unwatch:/t1"]);

    await release(); // unwatch resolves → watch dispatches next
    expect(calls).toEqual(["unwatch:/t1", "watch:/t1"]);
  });

  it("keeps the enqueue order regardless of interleaving gestures", async () => {
    void watchRepo("/t2");
    void unwatchRepo("/t2");
    void watchRepo("/t2");
    await tick();
    expect(calls).toEqual(["watch:/t2"]);

    await release();
    expect(calls).toEqual(["watch:/t2", "unwatch:/t2"]);
    await release();
    expect(calls).toEqual(["watch:/t2", "unwatch:/t2", "watch:/t2"]);
  });

  it("runs different paths independently, not blocked on each other", async () => {
    void unwatchRepo("/t3a");
    void watchRepo("/t3b");
    await tick();
    // /t3b is not queued behind /t3a — both dispatch on the first tick.
    expect(calls).toEqual(["unwatch:/t3a", "watch:/t3b"]);
  });

  it("does not stall the chain when a prior call rejects", async () => {
    void unwatchRepo("/t4");
    void watchRepo("/t4");
    await tick();
    expect(calls).toEqual(["unwatch:/t4"]);

    // Actually *reject* the unwatch's IPC — the wrapper swallows it and the
    // next link (watch) still dispatches, exercising `.then(op, op)`'s reject
    // branch.
    pending.shift()?.reject();
    await tick();
    expect(calls).toEqual(["unwatch:/t4", "watch:/t4"]);
  });

  it("normalizes the path so a trailing-slash reopen shares the chain and key", async () => {
    // A close on "/t5" and a reopen on "/t5/" must sequence on one chain and
    // reach the backend under one normalized key (GL-125 review).
    void unwatchRepo("/t5");
    void watchRepo("/t5/");
    await tick();
    // Only the unwatch has dispatched: the watch is queued behind it, not on a
    // separate chain — and the label shows the normalized key, not "/t5/".
    expect(calls).toEqual(["unwatch:/t5"]);

    await release();
    expect(calls).toEqual(["unwatch:/t5", "watch:/t5"]);
  });
});
