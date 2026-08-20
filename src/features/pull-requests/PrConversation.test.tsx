import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeKind } from "@/lib/api";
import type { PrAuthor, PrDetail } from "@/lib/prs";
import { PR_PENDING_ACTION, usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";
import { PrConversation } from "./PrConversation";

const { openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn<(href: string, onError?: (error: unknown) => void) => boolean>(),
}));
vi.mock("@/lib/openExternal", () => ({ openExternalUrl }));

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };

function openPr(over: Partial<PrDetail> = {}): PrDetail {
  return {
    num: 42,
    state: "open",
    draft: false,
    title: "feat: thing",
    branch: "feat/thing",
    base: "develop",
    author,
    age: "2h",
    add: 10,
    del: 2,
    changedFiles: 0,
    files: [],
    comments: 0,
    body: "",
    url: "https://github.com/x/y/pull/42",
    commentList: [],
    mergeable: "MERGEABLE",
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
  openExternalUrl.mockReset().mockReturnValue(true);
  useUi.setState({ confirm: null, showToast: vi.fn() });
  usePulls.setState({ prPendingActions: [] });
  useRepo.setState({
    summary: {
      path: "/repo",
      workdir: "/repo",
      headBranch: "main",
      headOid: "abc",
      detached: false,
    },
    forge: null,
  });
});

describe("PrConversation", () => {
  it("renders existing comments without a text editor", () => {
    render(
      <PrConversation
        pr={openPr({
          commentList: [
            {
              author,
              age: "now",
              createdAt: "2026-07-11T12:00:00Z",
              body: "Existing discussion",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Existing discussion")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /comment|request changes/i })).not.toBeInTheDocument();
  });

  it("submits approval without an action or body", async () => {
    const approvePr = vi.fn().mockResolvedValue("approved");
    usePulls.setState({ approvePr });
    render(<PrConversation pr={openPr()} />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await act(async () => {
      await useUi.getState().confirm?.onConfirm();
    });

    expect(approvePr).toHaveBeenCalledWith(42);
  });

  it("restores approval feedback from the store after remount", () => {
    usePulls.setState({
      prPendingActions: [{ id: 1, action: PR_PENDING_ACTION.Approve, prNum: 42 }],
    });

    render(<PrConversation key="remounted-42" pr={openPr()} />);

    expect(screen.getByRole("button", { name: "Approving…" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("opens the exact provider-supplied URL", async () => {
    useRepo.setState({
      forge: {
        hasRemote: true,
        kind: ForgeKind.CursorOrigin,
        forge: "Cursor Origin",
        host: "origin.cursor.com",
        webUrl: "https://cursor.com/origin/acme/app",
      },
    });
    const url = "https://cursor.com/codebase/acme/app/pull/42?tab=comments";
    render(<PrConversation pr={openPr({ url })} />);

    await userEvent.click(screen.getByRole("button", { name: "Open on Codebase" }));

    expect(openExternalUrl).toHaveBeenCalledWith(url, expect.any(Function));
  });

  it("surfaces a missing provider URL without opening anything", async () => {
    const showToast = vi.fn();
    useUi.setState({ showToast });
    render(<PrConversation pr={openPr({ url: "" })} />);

    await userEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("No GitHub URL for this PR", "error");
  });

  it("surfaces an invalid provider URL", async () => {
    const showToast = vi.fn();
    useUi.setState({ showToast });
    openExternalUrl.mockReturnValue(false);
    render(<PrConversation pr={openPr({ url: "javascript:alert(1)" })} />);

    await userEvent.click(screen.getByRole("button", { name: "Open on GitHub" }));

    expect(showToast).toHaveBeenCalledWith("Invalid GitHub URL for this PR", "error");
  });

  it("keeps the provider handoff on merged pull requests", () => {
    render(<PrConversation pr={openPr({ state: "merged" })} />);

    expect(screen.getByRole("button", { name: "Open on GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });
});
