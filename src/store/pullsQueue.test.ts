// The queued PR-list load machinery (GL-161): request-key identity, waiter
// coalescing, and the per-identity settle/cancel semantics. Pure — waiters are
// plain callbacks, so no store or IPC mocking is needed.
import { describe, expect, it, vi } from "vitest";

import type { GithubAccountRef } from "../lib/api";
import {
  cancelQueuedPrListLoad,
  mergeQueuedPrListLoad,
  prListRequestKey,
  settleQueuedPrListLoad,
  type PrListQueueWaiter,
  type QueuedPrListLoad,
} from "./pullsQueue";

const NUL = String.fromCharCode(0);

const account: GithubAccountRef = {
  provider: "gh",
  host: "github.com",
  accountId: "1001",
  login: "alice",
};

const waiter = (over: Partial<PrListQueueWaiter> = {}): PrListQueueWaiter => ({
  resolve: vi.fn(),
  reject: vi.fn(),
  force: false,
  key: "k",
  ...over,
});

const queued = (over: Partial<QueuedPrListLoad> = {}): QueuedPrListLoad => ({
  force: false,
  quiet: true,
  waiters: [],
  ...over,
});

describe("prListRequestKey", () => {
  it("joins path and account identity with a NUL so the fields can't collide", () => {
    expect(prListRequestKey("/repo", account)).toBe(`/repo${NUL}gh:github.com:1001:alice`);
    expect(prListRequestKey("/repo", null)).toBe(`/repo${NUL}default`);
    // Distinct accounts on the same repo produce distinct keys.
    expect(prListRequestKey("/repo", account)).not.toBe(
      prListRequestKey("/repo", { ...account, login: "bob", accountId: "2002" }),
    );
  });
});

describe("mergeQueuedPrListLoad", () => {
  it("starts a queue from the first request", () => {
    const next = queued({ force: true, quiet: false });
    expect(mergeQueuedPrListLoad(null, next)).toBe(next);
  });

  it("coalesces: force is OR-ed, quiet is AND-ed, waiters concatenate in order", () => {
    const a = waiter({ key: "a" });
    const b = waiter({ key: "b" });
    const merged = mergeQueuedPrListLoad(
      queued({ force: false, quiet: true, waiters: [a] }),
      queued({ force: true, quiet: false, waiters: [b] }),
    );
    expect(merged).toEqual({ force: true, quiet: false, waiters: [a, b] });
  });
});

describe("settleQueuedPrListLoad", () => {
  it("resolves waiters whose identity matches the completed run", () => {
    const match = waiter({ key: "k1", force: true });
    settleQueuedPrListLoad(queued({ waiters: [match] }), "k1");
    expect(match.resolve).toHaveBeenCalledOnce();
    expect(match.reject).not.toHaveBeenCalled();
  });

  it("cancels mismatched force waiters but quietly resolves fire-and-forget ones", () => {
    const forced = waiter({ key: "old", force: true });
    const passive = waiter({ key: "old", force: false });
    settleQueuedPrListLoad(queued({ waiters: [forced, passive] }), "new");
    expect(forced.reject).toHaveBeenCalledWith(expect.any(Error));
    expect(forced.resolve).not.toHaveBeenCalled();
    // Non-force waiters resolve so navigations don't surface unhandled rejections.
    expect(passive.resolve).toHaveBeenCalledOnce();
    expect(passive.reject).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty slot", () => {
    expect(() => settleQueuedPrListLoad(null, "k")).not.toThrow();
  });
});

describe("cancelQueuedPrListLoad", () => {
  it("rejects awaited force waiters with the reason and resolves the rest", () => {
    const reason = new Error("repo switched");
    const forced = waiter({ force: true });
    const passive = waiter({ force: false });
    cancelQueuedPrListLoad(queued({ waiters: [forced, passive] }), reason);
    expect(forced.reject).toHaveBeenCalledWith(reason);
    expect(passive.resolve).toHaveBeenCalledOnce();
    expect(passive.reject).not.toHaveBeenCalled();
    expect(() => cancelQueuedPrListLoad(null, reason)).not.toThrow();
  });
});
