import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubAccountRef, RepoSummary } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { useRepo } from "@/store/repo";
import { beginPublishedRepoSession } from "@/store/repoRequests";
import { useUi } from "@/store/ui";
import { useRunPrAction } from "./usePrAction";

const REPO_A: RepoSummary = {
  path: "/repo-a",
  workdir: "/repo-a",
  headBranch: "main",
  headOid: "aaa",
  detached: false,
};

const REPO_B: RepoSummary = {
  ...REPO_A,
  path: "/repo-b",
  workdir: "/repo-b",
  headOid: "bbb",
};

const account = (accountId: string): GithubAccountRef => ({
  provider: "gh",
  host: "github.com",
  accountId,
  login: `user-${accountId}`,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  beginPublishedRepoSession();
  useRepo.setState({ summary: REPO_A, forge: null });
  useAccounts.setState({ repoAccountId: null, repoAccountRef: null });
  useUi.setState({ showToast: vi.fn() });
});

describe("useRunPrAction result ownership", () => {
  it.each([
    {
      label: "repository path",
      drift: () => {
        beginPublishedRepoSession();
        useRepo.setState({ summary: REPO_B });
      },
    },
    {
      label: "same-path published session",
      drift: () => {
        beginPublishedRepoSession();
        useRepo.setState({ summary: { ...REPO_A } });
      },
    },
    {
      label: "bound account",
      drift: () => useAccounts.setState({ repoAccountRef: account("22") }),
    },
  ])("suppresses a success toast after $label drift", async ({ drift }) => {
    const server = deferred<string>();
    const showToast = useUi.getState().showToast as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useRunPrAction());
    let pending!: Promise<boolean>;

    act(() => {
      pending = result.current(() => server.promise, "Write succeeded");
    });
    act(drift);
    await act(async () => {
      server.resolve("server output");
      await expect(pending).resolves.toBe(false);
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it("suppresses a stale error toast after a same-path session change", async () => {
    const server = deferred<string>();
    const showToast = useUi.getState().showToast as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useRunPrAction());
    let pending!: Promise<boolean>;

    act(() => {
      pending = result.current(() => server.promise);
      beginPublishedRepoSession();
      useRepo.setState({ summary: { ...REPO_A } });
    });
    await act(async () => {
      server.reject(new Error("old repo failed"));
      await expect(pending).resolves.toBe(false);
    });

    expect(showToast).not.toHaveBeenCalled();
  });

  it("composes repository ownership with a component-local result guard", async () => {
    const showToast = useUi.getState().showToast as ReturnType<typeof vi.fn>;
    const ownsDialog = vi.fn(() => false);
    const { result } = renderHook(() => useRunPrAction());
    let ok!: boolean;

    await act(async () => {
      ok = await result.current(
        () => Promise.resolve("created"),
        "PR created",
        ownsDialog,
      );
    });

    expect(ok).toBe(false);
    expect(ownsDialog).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("still toasts and returns true while both owners remain current", async () => {
    const showToast = useUi.getState().showToast as ReturnType<typeof vi.fn>;
    const { result } = renderHook(() => useRunPrAction());
    let ok!: boolean;

    await act(async () => {
      ok = await result.current(() => Promise.resolve("server first line\nmore"));
    });

    expect(ok).toBe(true);
    expect(showToast).toHaveBeenCalledWith("server first line", "ok");
  });
});
