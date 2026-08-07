// The "Open a pull request…" entry the graph's branch pills and the navigator
// rows share (GL-347): offered for any published local branch on a PR-capable
// forge, and it opens the form for the branch that was clicked rather than
// whichever one happens to be checked out.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ForgeKind, type BranchInfo, type RepoForge } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { useUi, contextMenuOf, MenuKind } from "@/store/ui";
import { BranchContextMenu } from "./BranchContextMenu";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const PR_ITEM = "Open a pull request…";

const branch = (over: Partial<BranchInfo>): BranchInfo =>
  ({
    name: "feat/x",
    kind: "local",
    target: "aaa1111",
    isHead: false,
    upstream: "origin/feat/x",
    remote: null,
    pushRemote: null,
    ...over,
  }) as BranchInfo;

const forge = (kind: string | null): RepoForge =>
  ({ hasRemote: true, kind, forge: kind, host: "example.test", webUrl: null }) as RepoForge;

function open(over: { branches?: BranchInfo[]; forge?: RepoForge | null; branch?: string } = {}) {
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "bbb2222",
      detached: false,
    } as never,
    branches: over.branches ?? [branch({}), branch({ name: "main", isHead: true })],
    forge: over.forge === undefined ? forge(ForgeKind.GitHub) : over.forge,
  });
  useUi.setState({
    menu: { kind: MenuKind.Context, state: { x: 10, y: 10, branch: over.branch ?? "feat/x", isCurrent: false } },
    createPrOpen: false,
    createPrHead: null,
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

describe("BranchContextMenu — open a pull request", () => {
  it("opens the form for the branch that was right-clicked", async () => {
    open();
    render(<BranchContextMenu />);

    await userEvent.click(screen.getByRole("menuitem", { name: PR_ITEM }));

    // Not "main" — a pull request opens from the branch you clicked, which is
    // why the head has to be carried rather than read off HEAD.
    expect(useUi.getState().createPrHead).toBe("feat/x");
    expect(useUi.getState().createPrOpen).toBe(true);
    // Opening the dialog dismisses the menu that raised it.
    expect(contextMenuOf(useUi.getState())).toBeNull();
  });

  it("sits below Checkout — the commoner verb on a branch you are pointing at", () => {
    open();
    render(<BranchContextMenu />);

    const labels = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(labels.indexOf(PR_ITEM)).toBeGreaterThan(labels.findIndex((l) => l?.startsWith("Checkout")));
    expect(labels.indexOf(PR_ITEM)).toBeGreaterThan(labels.findIndex((l) => l?.startsWith("Push")));
  });

  it("is offered for a branch that has not been pushed", () => {
    // The state you are in most often when you want a pull request. The form
    // publishes before it creates, so hiding the item here strands the user.
    open({ branches: [branch({ upstream: null }), branch({ name: "main", isHead: true })] });
    render(<BranchContextMenu />);

    expect(screen.getByRole("menuitem", { name: PR_ITEM })).toBeInTheDocument();
  });

  it("is not offered on a forge without pull requests", () => {
    open({ forge: forge(ForgeKind.AzureDevOps) });
    render(<BranchContextMenu />);

    expect(screen.queryByRole("menuitem", { name: PR_ITEM })).not.toBeInTheDocument();
  });

  it("is still offered while the forge is being detected", () => {
    // Null is "not known yet". Hiding then showing the item as detection lands
    // is worse than showing it and letting the create fail loudly.
    open({ forge: null });
    render(<BranchContextMenu />);

    expect(screen.getByRole("menuitem", { name: PR_ITEM })).toBeInTheDocument();
  });

  it("is not offered for a remote branch", () => {
    open({
      branches: [branch({ name: "origin/feat/x", kind: "remote", remote: "origin" })],
      branch: "origin/feat/x",
    });
    render(<BranchContextMenu />);

    expect(screen.queryByRole("menuitem", { name: PR_ITEM })).not.toBeInTheDocument();
  });
});
