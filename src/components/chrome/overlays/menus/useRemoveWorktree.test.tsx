// GL-303: leased removal preview is async and `confirm` is a single slot, so
// out-of-order results must not open — or overwrite — a confirm.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type { RemoveWorktreePreview } from "@/lib/api";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useRemoveWorktree } from "./useRemoveWorktree";

const preview = (
  over: Partial<RemoveWorktreePreview> = {},
): RemoveWorktreePreview => ({
  summary: "Remove the linked worktree?",
  details: ["The linked worktree will be removed."],
  warnings: [],
  expectedState: "v1:lease",
  requiresForce: false,
  locked: false,
  branch: "feat",
  headOid: "abc1234",
  dirty: { modified: 0, untracked: 0, ignored: 0 },
  ...over,
});

const request = (over: Partial<Parameters<ReturnType<typeof useRemoveWorktree>>[0]> = {}) => ({
  name: "repo-feat",
  path: "/work/repo-feat",
  branch: "feat" as string | null,
  head: null,
  locked: false,
  ...over,
});

beforeEach(() => {
  useRepo.setState({
    summary: { path: "/work/repo", workdir: "/work/repo", headBranch: "main", headOid: "head", detached: false },
    changes: { staged: [], unstaged: [], conflicted: [], advanced: emptyAdvancedState },
    worktrees: [],
    removeWorktree: vi.fn().mockResolvedValue("ok"),
    previewRemoveWorktree: vi.fn(),
  });
  useUi.setState({ confirm: null, worktreeMenu: null, contextMenu: null });
});

describe("useRemoveWorktree", () => {
  it("discards a stale preview so only the newest removal opens a confirm", async () => {
    const resolvers: ((v: RemoveWorktreePreview) => void)[] = [];
    useRepo.setState({
      previewRemoveWorktree: vi.fn(
        () => new Promise<RemoveWorktreePreview>((resolve) => resolvers.push(resolve)),
      ),
    });
    const { result } = renderHook(() => useRemoveWorktree());

    void result.current(request({ name: "first", path: "/work/first" }));
    void result.current(request({ name: "second", path: "/work/second" }));
    expect(resolvers).toHaveLength(2);

    resolvers[1]!(
      preview({
        dirty: { modified: 4, untracked: 0, ignored: 0 },
        requiresForce: true,
        summary: "second has uncommitted work that removing it would discard.",
      }),
    );
    await waitFor(() => expect(useUi.getState().confirm).not.toBeNull());
    const opened = useUi.getState().confirm;
    expect(opened?.title).toContain("second");

    resolvers[0]!(
      preview({ dirty: { modified: 99, untracked: 0, ignored: 0 }, requiresForce: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(useUi.getState().confirm).toBe(opened);
    expect(opened?.warnings?.join(" ")).toContain("4 modified files");
  });

  it("does not remove against a repo the confirm was not built for", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    useRepo.setState({
      removeWorktree,
      previewRemoveWorktree: vi.fn().mockResolvedValue(preview()),
    });
    const { result } = renderHook(() => useRemoveWorktree());
    await result.current(request());
    const confirm = useUi.getState().confirm;
    expect(confirm).not.toBeNull();

    useRepo.setState({
      summary: { path: "/work/other", workdir: "/work/other", headBranch: "main", headOid: "head", detached: false },
    });
    confirm!.onConfirm();
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it("discards a preview that resolves after the same repo path was reopened", async () => {
    let resolvePreview!: (value: RemoveWorktreePreview) => void;
    useRepo.setState({
      previewRemoveWorktree: vi.fn(
        () => new Promise<RemoveWorktreePreview>((resolve) => {
          resolvePreview = resolve;
        }),
      ),
    });
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
    resolvePreview(preview());
    await Promise.resolve();
    await Promise.resolve();

    expect(useUi.getState().confirm).toBeNull();
  });

  it("passes the lease expectedState on confirm, not a client force flag", async () => {
    const removeWorktree = vi.fn().mockResolvedValue("ok");
    useRepo.setState({
      removeWorktree,
      previewRemoveWorktree: vi
        .fn()
        .mockResolvedValue(preview({ expectedState: "v1:abc", requiresForce: true })),
    });
    const { result } = renderHook(() => useRemoveWorktree());
    await result.current(request());
    useUi.getState().confirm!.onConfirm();
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledWith("/work/repo-feat", "v1:abc"));
  });
});
