import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PullRequest, PrAuthor } from "@/lib/prs";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import * as prState from "./prState";
import { LeftPanel } from "./LeftPanel";

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    num: 24,
    state: "open",
    draft: false,
    title: "GL-34 checks",
    branch: "GL-34-pr-check-status-ui",
    base: "develop",
    author,
    age: "1h",
    add: 10,
    del: 2,
    changedFiles: 0,
    files: [],
    comments: 0,
    body: "",
    url: "https://github.com/Siomkin/GitLane/pull/24",
    commentList: [],
    mergeable: "",
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
    participants: [author],
    ...over,
  };
}

beforeEach(() => {
  useUi.setState({ prFilter: "open", prSelected: null });
  useRepo.setState({
    summary: {
      path: "/repo",
      headBranch: "develop",
    } as unknown as ReturnType<typeof useRepo.getState>["summary"],
    forge: null,
  });
  usePulls.setState({
    pullRequests: [],
    prsLoading: false,
    prError: null,
    prsFetchedAt: Date.now(),
    loadPullRequests: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("LeftPanel pull request list", () => {
  it("shows draft PRs in the open list with a Draft state label", () => {
    usePulls.setState({
      pullRequests: [
        pr({ num: 24, draft: true, title: "Draft check status UI" }),
        pr({ num: 22, title: "Ready review layout" }),
      ],
    });

    render(<LeftPanel />);

    expect(screen.getByText("Draft check status UI")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Ready review layout")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("keeps the updated timestamp moving without another PR fetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    usePulls.setState({ prsFetchedAt: Date.now() });

    render(<LeftPanel />);

    expect(screen.getByText("Updated 0s ago")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText("Updated 3s ago")).toBeInTheDocument();
    expect(usePulls.getState().loadPullRequests).toHaveBeenCalledTimes(1);
  });

  it("does not rerender pull request rows when the timestamp ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    usePulls.setState({
      pullRequests: [pr()],
      prsFetchedAt: Date.now(),
    });
    const stateViewSpy = vi.spyOn(prState, "stateView");

    render(<LeftPanel />);

    expect(stateViewSpy).toHaveBeenCalledTimes(1);
    stateViewSpy.mockClear();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("Updated 1s ago")).toBeInTheDocument();
    expect(stateViewSpy).not.toHaveBeenCalled();
  });
});
