import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { ForgeKind, type RepoForge, type RepoSummary } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { usePulls } from "@/store/pulls";
import { useAccounts } from "@/store/accounts";
import { ActionBar } from "./ActionBar";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "main",
  headOid: "abc1234",
  detached: false,
};

const FORGE: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
};

// True when `a` precedes `b` in document order.
const precedes = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useRepo.setState({ summary: SUMMARY, forge: FORGE });
  usePulls.setState({ pullRequests: [] });
  useAccounts.setState({ accounts: [], accountsError: null, accountsLoading: false, repoAccountRef: null });
});

describe("ActionBar layout order", () => {
  it("places the provider indicator in the right cluster, just before Fetch (after the branch trigger)", () => {
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);

    const commitsTab = screen.getByRole("button", { name: /Commits/ });
    const branchTrigger = screen.getByTitle("Branches, worktrees & stashes");
    const provider = screen.getByRole("button", { name: /open repository on its provider/i });
    const fetchBtn = screen.getByTitle("Fetch");

    // Segmented control → branch trigger → provider indicator → Fetch.
    expect(precedes(commitsTab, branchTrigger)).toBe(true);
    expect(precedes(branchTrigger, provider)).toBe(true);
    expect(precedes(provider, fetchBtn)).toBe(true);
  });

  it("renders no provider indicator when the repo's forge is unknown", () => {
    useRepo.setState({ forge: null });
    render(<ActionBar activeTab="history" onTabChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /open repository on its provider/i })).toBeNull();
  });
});
