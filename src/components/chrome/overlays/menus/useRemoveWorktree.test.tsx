// GL-296 review follow-up: the removal probe is async and `confirm` is a single
// slot, so out-of-order results must not open — or overwrite — a confirm. Driven
// through the hook directly because the menu now closes on click, which makes the
// two-clicks-in-one-menu path impossible to stage.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useRemoveWorktree } from "./useRemoveWorktree";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const request = (over: Partial<Parameters<ReturnType<typeof useRemoveWorktree>>[0]> = {}) => ({
  name: "repo-feat",
  path: "/work/repo-feat",
  branch: "feat" as string | null,
  head: null,
  locked: false,
  ...over,
});

beforeEach(() => {
  invokeMock.mockReset();
  useRepo.setState({
    summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    worktrees: [],
    removeWorktree: vi.fn().mockResolvedValue("ok"),
  });
  useUi.setState({ confirm: null, worktreeMenu: null, contextMenu: null });
});

describe("useRemoveWorktree", () => {
  it("discards a stale probe so only the newest removal opens a confirm", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "worktree_dirty_state"
        ? new Promise((resolve) => resolvers.push(resolve))
        : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    const { result } = renderHook(() => useRemoveWorktree());

    void result.current(request({ name: "first", path: "/work/first" }));
    void result.current(request({ name: "second", path: "/work/second" }));
    expect(resolvers).toHaveLength(2);

    // The newest probe resolves first, then the stale one lands out of order.
    resolvers[1]!({ modified: 4, untracked: 0, ignored: 0 });
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    const opened = useUi.getState().confirm;
    expect(opened?.title).toContain("second");

    resolvers[0]!({ modified: 99, untracked: 0, ignored: 0 });
    await Promise.resolve();
    await Promise.resolve();
    // The stale result must not replace the newest click's confirm.
    expect(useUi.getState().confirm).toBe(opened);
    expect(opened?.warnings?.join(" ")).toContain("4 modified files");
  });

  it("does not remove against a repo the confirm was not built for", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    useRepo.setState({ removeWorktree });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "worktree_dirty_state"
        ? Promise.resolve({ modified: 0, untracked: 0, ignored: 0 })
        : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    const { result } = renderHook(() => useRemoveWorktree());
    await result.current(request());
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();

    // The user switches repos with the dialog still open; accepting it must not
    // aim the removal at the newly-active repo.
    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "main", headOid: "head", detached: false },
    });
    confirm!.onConfirm();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("discards a probe that resolves after the same repo path was reopened", async () => {
    let resolveProbe!: (value: unknown) => void;
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "worktree_dirty_state"
        ? new Promise((resolve) => { resolveProbe = resolve; })
        : Promise.reject(new Error(`unexpected invoke: ${cmd}`)),
    );
    const { result } = renderHook(() => useRemoveWorktree());

    void result.current(request());
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "main", headOid: "head", detached: false },
    });
    beginPublishedRepoSession();
    useRepo.setState({
      summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "new", detached: false },
    });
    resolveProbe({ modified: 0, untracked: 0, ignored: 0 });
    await Promise.resolve();
    await Promise.resolve();

    expect(useUi.getState().confirm).toBeNull();
  });
});
