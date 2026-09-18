// links.ts is the only upward channel between stores, and it stays useful only
// while it stays tiny. These cases pin its surface, its unbound defaults (what a
// store under test sees in isolation), and that importing the stores binds it.

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("storeLinks", () => {
  it("has exactly the four sanctioned entries", async () => {
    const { storeLinks } = await import("./links");

    // Adding a fifth needs a rules edit first (architecture-rules-react.md §1).
    expect(Object.keys(storeLinks).sort()).toEqual([
      "listRemotes",
      "openRepo",
      "refreshRepo",
      "reloadPulls",
    ]);
  });

  it("defaults to no open repo and no-op refreshes while unbound", async () => {
    vi.resetModules();
    const { storeLinks } = await import("./links");

    expect(storeLinks.openRepo()).toEqual({ summary: null, remotes: [], forge: null });
    await expect(storeLinks.refreshRepo()).resolves.toBe(false);
    await expect(storeLinks.listRemotes()).resolves.toEqual([]);
    await expect(storeLinks.reloadPulls()).resolves.toBeUndefined();
  });

  it("is bound to the live repo and pulls stores once they are imported", async () => {
    vi.resetModules();
    const { storeLinks } = await import("./links");
    const { useRepo } = await import("./repo");
    const { usePulls } = await import("./pulls");

    // A getter, not a copy: it reflects state set after binding.
    const remotes = [{ name: "origin" }] as ReturnType<typeof storeLinks.openRepo>["remotes"];
    useRepo.setState({ remotes });
    expect(storeLinks.openRepo().remotes).toBe(remotes);

    const refresh = vi.fn().mockResolvedValue(true);
    const listRemotes = vi.fn().mockResolvedValue(remotes);
    const loadPullRequests = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({ refresh, listRemotes });
    usePulls.setState({ loadPullRequests });

    await expect(storeLinks.refreshRepo({ prs: false })).resolves.toBe(true);
    expect(refresh).toHaveBeenCalledWith({ prs: false });
    await storeLinks.listRemotes();
    expect(listRemotes).toHaveBeenCalledOnce();
    await storeLinks.reloadPulls();
    expect(loadPullRequests).toHaveBeenCalledOnce();
  });
});
