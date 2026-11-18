import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import type { MenuItem } from "@/components/chrome/overlays/shared";
import { useRepo } from "@/store/repo";
import type { BranchMenuContext } from "./context";
import { dangerZoneItems } from "./destructiveActions";

// The Danger zone rows as a pure function of the menu context: each row's
// click reaches the right store/ui action with the right arguments.
const ctx = (over: Partial<BranchMenuContext> = {}) => {
  const run = vi.fn(async (op: () => Promise<string>) => void (await op()));
  return {
    b: "feature",
    tip: "feature-oid",
    upstream: "origin/feature",
    isCurrent: false,
    isLocal: true,
    repoPath: "/work/repo",
    close: vi.fn(),
    run,
    requestConfirm: vi.fn(),
    requestPrompt: vi.fn(),
    existingWorktree: null,
    localDeleteMode: "branch",
    remoteDeleteTarget: null,
    upstreamDeleteTarget: null,
    openDeleteWorktree: vi.fn(),
    openDeleteBranch: vi.fn(),
    renameBranchTo: vi.fn().mockResolvedValue("Renamed"),
    forcePush: vi.fn(),
    setUpstreamFor: vi.fn().mockResolvedValue("Set"),
    deleteRemoteBranch: vi.fn().mockResolvedValue("Deleted"),
    ...over,
  } as unknown as BranchMenuContext;
};

const item = (items: MenuItem[], label: string) => {
  const found = items.find((i) => i.label === label);
  if (!found) throw new Error(`no row ${label}: ${items.map((i) => i.label).join(", ")}`);
  return found;
};

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({ summary: { path: "/work/repo" } as never });
});

describe("dangerZoneItems", () => {
  it("opens the delete dialog with the live upstream, pinned to this repo", () => {
    const target = { remote: "origin", branch: "feature", oid: "remote-oid" };
    const c = ctx({ upstreamDeleteTarget: target });
    item(dangerZoneItems(c), "Delete feature").onClick!();
    expect(c.openDeleteBranch).toHaveBeenCalledWith({ branch: "feature", repoPath: "/work/repo", alsoRemote: target });
  });

  it("disables Delete without a repository", () => {
    expect(item(dangerZoneItems(ctx({ repoPath: null })), "Delete feature").disabled).toBe(true);
  });

  it("renames and sets the upstream through their prompts", async () => {
    const c = ctx();
    const items = dangerZoneItems(c);

    item(items, "Rename feature…").onClick!();
    (c.requestPrompt as ReturnType<typeof vi.fn>).mock.calls[0][0].onSubmit("feature-2");
    await waitFor(() => expect(c.renameBranchTo).toHaveBeenCalledWith("feature", "feature-2"));

    item(items, "Change upstream (origin/feature)…").onClick!();
    (c.requestPrompt as ReturnType<typeof vi.fn>).mock.calls[1][0].onSubmit("upstream/feature");
    await waitFor(() => expect(c.setUpstreamFor).toHaveBeenCalledWith("feature", "upstream/feature"));
  });

  it("deletes a remote-tracking ref on its remote after the preview confirm", async () => {
    invokeMock.mockResolvedValue({ summary: "Delete feature on origin", details: [], warnings: [] });
    const c = ctx({
      b: "origin/feature",
      isLocal: false,
      localDeleteMode: "none",
      remoteDeleteTarget: { remote: "origin", branch: "feature" },
    });

    item(dangerZoneItems(c), "Delete origin/feature on remote").onClick!();
    await waitFor(() => expect(c.requestConfirm).toHaveBeenCalled());
    const confirm = (c.requestConfirm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(confirm.message).toMatch(/affects everyone using it/);
    confirm.onConfirm();
    await waitFor(() => expect(c.deleteRemoteBranch).toHaveBeenCalledWith("origin", "feature", "feature-oid"));
  });
});
