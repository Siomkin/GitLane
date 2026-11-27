import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    if (command === "repository_stacks") return Promise.resolve([]);
    if (command === "pull_request_stack") return Promise.resolve(null);
    return invokeMock(command, args);
  },
}));

import { ForgeKind, type BranchInfo, type RepoForge, type RepoSummary } from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { usePulls } from "@/store/pulls";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { capabilitiesFor } from "@/test/forgeFixtures";
import { ActionBar } from "./ActionBar";

const SUMMARY: RepoSummary = {
  path: "/repo",
  workdir: "/repo",
  headBranch: "feat/mcp",
  headOid: "abc1234",
  detached: false,
  unborn: false,
  isWorktree: false,
};

const FORGE: RepoForge = {
  hasRemote: true,
  kind: ForgeKind.GitHub,
  capabilities: capabilitiesFor(ForgeKind.GitHub),
  forge: "GitHub",
  host: "github.com",
  webUrl: "https://github.com/o/r",
  prRemote: "origin",
};

const localBranch = (over: Partial<BranchInfo> = {}): BranchInfo => ({
  name: "feat/mcp",
  kind: "local",
  target: "abc1234",
  isHead: true,
  upstream: "origin/develop",
  upstreamRemote: "origin",
  pushRemote: "origin",
  remote: null,
  sync: { status: "diverged", upstream: "origin/develop", ahead: 2, behind: 1 },
  ...over,
});

const realPush = useRepo.getState().push;
const realPublishBranch = useRepo.getState().publishBranch;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
  useRepo.setState({
    summary: SUMMARY,
    forge: FORGE,
    remotes: [],
    branches: [],
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    loading: false,
    fetchingPath: null,
    push: realPush,
    publishBranch: realPublishBranch,
  });
  usePulls.setState({ pullRequests: [] });
  useAccounts.setState({ accounts: [], accountsError: null, accountsLoading: false });
  useUi.setState({ prompt: null, confirm: null, menu: null, navOpen: false });
});

describe("ActionBar mismatched-upstream publish & fork routing", () => {
  it("hides Force push and opens Publish for a diverged branch tracking a differently-named remote", () => {
    const publishBranch = vi.fn().mockResolvedValue("published");
    useRepo.setState({
      publishBranch,
      branches: [
        localBranch(),
        {
          name: "origin/develop",
          kind: "remote",
          target: "bbb",
          isHead: false,
          upstream: null,
          remote: "origin",
        },
      ],
    });

    render(<ActionBar />);

    expect(screen.queryByTitle(/Force-push/)).not.toBeInTheDocument();
    const pushBtn = screen.getByRole("button", { name: /^Push$/i });
    expect(pushBtn).toBeEnabled();
    fireEvent.click(pushBtn);

    const prompt = useUi.getState().prompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.defaultValue).toBe("origin/feat/mcp");
  });

  it("keeps ordinary Push for a triangular fork branch ahead of upstream/develop", () => {
    const push = vi.fn().mockResolvedValue(undefined);
    useRepo.setState({
      push,
      branches: [
        localBranch({
          upstream: "upstream/develop",
          upstreamRemote: "upstream",
          pushRemote: "origin",
          sync: { status: "ahead", upstream: "upstream/develop", ahead: 1, behind: 0 },
        }),
        {
          name: "upstream/develop",
          kind: "remote",
          target: "bbb",
          isHead: false,
          upstream: null,
          remote: "upstream",
        },
      ],
    });

    render(<ActionBar />);

    const pushBtns = screen.getAllByTitle("1 commit ahead of upstream/develop.");
    fireEvent.click(pushBtns[pushBtns.length - 1]);

    expect(useUi.getState().prompt).toBeNull();
    expect(push).toHaveBeenCalledOnce();
  });
});
