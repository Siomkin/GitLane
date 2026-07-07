import { beforeEach, describe, expect, it } from "vitest";
import { useTerminals } from "./terminals";

// Pure in-memory store (no IPC): reset the map between tests.
beforeEach(() => useTerminals.setState({ byRepo: {} }));

const A = "/work/GitLane";
const B = "/work/Other";
const t = () => useTerminals.getState();
const tabs = (repo: string) => t().byRepo[repo]?.tabs ?? [];
const active = (repo: string) => t().byRepo[repo]?.activeId ?? null;

describe("openTab", () => {
  it("appends a tab, makes it active, and titles it from the repo basename", () => {
    const id = t().openTab(A);
    expect(tabs(A)).toHaveLength(1);
    expect(active(A)).toBe(id);
    expect(tabs(A)[0].title).toBe("GitLane 1");
  });

  it("numbers tabs monotonically and does not reuse a number after close", () => {
    t().openTab(A); // GitLane 1
    const id2 = t().openTab(A); // GitLane 2
    t().closeTab(A, id2);
    t().openTab(A); // GitLane 3 — not a reused "2"
    expect(tabs(A).map((x) => x.title)).toEqual(["GitLane 1", "GitLane 3"]);
  });

  it("keeps repos isolated", () => {
    t().openTab(A);
    t().openTab(B);
    expect(tabs(A)).toHaveLength(1);
    expect(tabs(B)).toHaveLength(1);
    expect(tabs(B)[0].title).toBe("Other 1");
  });
});

describe("ensureTab", () => {
  it("creates the first tab when none exist", () => {
    const id = t().ensureTab(A);
    expect(tabs(A)).toHaveLength(1);
    expect(active(A)).toBe(id);
  });

  it("is a no-op that returns the active id when a tab already exists", () => {
    const id = t().openTab(A);
    const got = t().ensureTab(A);
    expect(got).toBe(id);
    expect(tabs(A)).toHaveLength(1);
  });
});

describe("setActiveTab", () => {
  it("switches the active tab", () => {
    const a = t().openTab(A);
    const b = t().openTab(A);
    expect(active(A)).toBe(b);
    t().setActiveTab(A, a);
    expect(active(A)).toBe(a);
  });

  it("ignores an unknown id (no active pointing at a missing tab)", () => {
    const a = t().openTab(A);
    t().setActiveTab(A, "nope");
    expect(active(A)).toBe(a);
  });

  it("ignores a missing repo", () => {
    expect(() => t().setActiveTab("/nope", "x")).not.toThrow();
    expect(t().byRepo["/nope"]).toBeUndefined();
  });
});

describe("closeTab", () => {
  it("returns true only when the last tab is closed", () => {
    const a = t().openTab(A);
    const b = t().openTab(A);
    expect(t().closeTab(A, a)).toBe(false);
    expect(t().closeTab(A, b)).toBe(true);
    expect(tabs(A)).toHaveLength(0);
  });

  it("returns false for a missing repo", () => {
    expect(t().closeTab("/nope", "x")).toBe(false);
  });

  it("returns false (and hides nothing) for an unknown tab id", () => {
    const a = t().openTab(A);
    expect(t().closeTab(A, "nope")).toBe(false);
    expect(tabs(A).map((x) => x.id)).toEqual([a]); // unchanged
  });

  it("closing the active middle tab activates the tab that took its slot", () => {
    const a = t().openTab(A);
    const b = t().openTab(A);
    const c = t().openTab(A);
    t().setActiveTab(A, b);
    t().closeTab(A, b);
    // b's slot (index 1) is now c → c becomes active.
    expect(active(A)).toBe(c);
    expect(tabs(A).map((x) => x.id)).toEqual([a, c]);
  });

  it("closing the active last tab falls back to the left neighbour", () => {
    const a = t().openTab(A);
    const b = t().openTab(A);
    expect(active(A)).toBe(b);
    t().closeTab(A, b);
    expect(active(A)).toBe(a);
  });

  it("closing a non-active tab leaves the active tab unchanged", () => {
    const a = t().openTab(A);
    const b = t().openTab(A);
    t().setActiveTab(A, a);
    t().closeTab(A, b);
    expect(active(A)).toBe(a);
  });
});

describe("closeRepoTerminals", () => {
  it("drops all of a repo's tabs (so the panes manager disposes its PTYs)", () => {
    t().openTab(A);
    t().openTab(A);
    t().openTab(B);
    t().closeRepoTerminals(A);
    expect(t().byRepo[A]).toBeUndefined();
    expect(tabs(B)).toHaveLength(1); // other repos untouched
  });

  it("is a no-op for a repo with no terminals", () => {
    t().openTab(B);
    expect(() => t().closeRepoTerminals("/never-opened")).not.toThrow();
    expect(Object.keys(t().byRepo)).toEqual([B]);
  });
});
