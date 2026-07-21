import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrAuthor, PullRequest } from "@/lib/prs";
import type { ReviewThread } from "@/lib/api";
import { usePulls } from "@/store/pulls";
import { useRepo } from "@/store/repo";
import { PrConversation } from "./PrConversation";
import { ReviewThreads } from "./ReviewThreads";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const author: PrAuthor = { name: "Alex", login: "alex", initials: "AL" };
const defaultResolveThread = usePulls.getState().resolveThread;
const defaultReplyThread = usePulls.getState().replyThread;

const htmlComment = `<details>
<summary>Maintainer changes</summary>
<p>Rendered <strong>comment</strong> body.</p>
</details>
<script>alert("x")</script>`;
const badgeComment = `![P2 Badge](https://img.shields.io/badge/P2-yellow.svg) Preserve empty successful PR lists`;

const makePr = (over: Partial<PullRequest> = {}): PullRequest => ({
  num: 21,
  state: "merged",
  draft: false,
  title: "Render comments",
  branch: "dependabot/npm",
  base: "develop",
  author,
  age: "1h",
  add: 1,
  del: 1,
  changedFiles: 0,
  files: [],
  comments: 1,
  body: "",
  url: "https://github.com/x/y/pull/21",
  commentList: [],
  mergeable: "",
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  commits: [],
  participants: [author],
  ...over,
});

beforeEach(() => {
  openUrl.mockClear();
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
  usePulls.setState({
    prThreads: {},
    prThreadsError: {},
    prThreadsTruncated: {},
    prsFetchedAt: 0,
    prPendingActions: [],
    loadPrThreads: vi.fn().mockResolvedValue(undefined),
    resolveThread: defaultResolveThread,
    replyThread: defaultReplyThread,
  });
});

describe("PR comment markdown", () => {
  it("renders discussion comment HTML through the shared Markdown renderer", () => {
    const pr = makePr({
      commentList: [
        {
          author,
          age: "now",
          createdAt: "2026-07-11T00:00:00Z",
          body: `${badgeComment}\n\n${htmlComment}`,
        },
      ],
    });

    const { container } = render(<PrConversation pr={pr} />);

    expect(screen.getByText("P2")).toBeInTheDocument();
    expect(screen.getByText("Preserve empty successful PR lists")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("details")).toBeInTheDocument();
    expect(screen.getByText("Maintainer changes")).toBeInTheDocument();
    expect(screen.getByText("comment")).toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("<details>");
  });

  it("renders review-thread comment HTML through the shared Markdown renderer", () => {
    const pr = makePr({ state: "open" });
    const thread: ReviewThread = {
      id: "thread-1",
      path: "package.json",
      line: 12,
      isResolved: false,
      isOutdated: false,
      commentsTruncated: false,
      comments: [
        {
          author: { name: "dependabot[bot]", login: "dependabot[bot]" },
          body: htmlComment,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    usePulls.setState({ prThreads: { [pr.num]: [thread] } });

    const { container } = render(<ReviewThreads pr={pr} />);

    expect(container.querySelector("details")).toBeInTheDocument();
    expect(screen.getByText("Maintainer changes")).toBeInTheDocument();
    expect(screen.getByText("comment")).toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("<summary>");
  });

  it("notes when a thread's comments were truncated by the fetch cap", () => {
    const pr = makePr({ state: "open" });
    const thread: ReviewThread = {
      id: "thread-trunc",
      path: "src/big.ts",
      line: 5,
      isResolved: false,
      isOutdated: false,
      commentsTruncated: true,
      comments: [
        { author: { name: "Alex", login: "alex" }, body: "first", createdAt: new Date().toISOString() },
      ],
    };
    usePulls.setState({ prThreads: { [pr.num]: [thread] } });

    render(<ReviewThreads pr={pr} />);

    expect(screen.getByText(/more comments than shown here/i)).toBeInTheDocument();
  });

  it("warns when the backend review-thread page cap omitted later threads", () => {
    const pr = makePr({ state: "open" });
    const thread: ReviewThread = {
      id: "thread-page-cap",
      path: "src/big.ts",
      line: 5,
      isResolved: false,
      isOutdated: false,
      commentsTruncated: false,
      comments: [],
    };
    usePulls.setState({
      prThreads: { [pr.num]: [thread] },
      prThreadsTruncated: { [pr.num]: true },
    });

    render(<ReviewThreads pr={pr} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing the first 1 review thread — some threads were not loaded.",
    );
  });

  it("does not show the truncation note for a complete thread", () => {
    const pr = makePr({ state: "open" });
    const thread: ReviewThread = {
      id: "thread-full",
      path: "src/small.ts",
      line: 1,
      isResolved: false,
      isOutdated: false,
      commentsTruncated: false,
      comments: [
        { author: { name: "Alex", login: "alex" }, body: "only one", createdAt: new Date().toISOString() },
      ],
    };
    usePulls.setState({ prThreads: { [pr.num]: [thread] } });

    render(<ReviewThreads pr={pr} />);

    expect(screen.queryByText(/more comments than shown here/i)).not.toBeInTheDocument();
  });

  it("marks outdated review threads even when GitHub no longer returns a current line", () => {
    const pr = makePr({ state: "open" });
    usePulls.setState({
      prThreads: {
        [pr.num]: [
          {
            id: "thread-outdated",
            path: "src/store/pulls.ts",
            line: null,
            isResolved: false,
            isOutdated: true,
            commentsTruncated: false,
            comments: [
              {
                author: { name: "reviewer", login: "reviewer" },
                body: "stale comment",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      },
    });

    render(<ReviewThreads pr={pr} />);

    expect(screen.getByText("Original line")).toBeInTheDocument();
    expect(screen.getByText("Outdated")).toBeInTheDocument();
  });

  it("resets the resolved-thread filter when the PR changes", async () => {
    const first = makePr({ num: 21, state: "open" });
    const second = makePr({ num: 22, state: "open" });
    const resolved = { ...thread("resolved", "resolved comment"), isResolved: true };
    usePulls.setState({ prThreads: { [first.num]: [resolved], [second.num]: [resolved] } });
    const view = render(<ReviewThreads key={first.num} pr={first} />);

    await userEvent.click(screen.getByText("Show resolved (1)"));
    expect(screen.getByText("resolved comment")).toBeInTheDocument();

    view.rerender(<ReviewThreads key={second.num} pr={second} />);
    expect(screen.queryByText("resolved comment")).not.toBeInTheDocument();
    expect(screen.getByText("Show resolved (1)")).toBeInTheDocument();
  });

  // Generous timeout: this userEvent-driven case blew the 5s default when the
  // CI box was starved (it overlapped a desktop build being killed) — the test
  // is correct, just slow under load.
  it("submits review-thread replies through the pulls store", { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    const pr = makePr({ state: "open" });
    const replyThread = vi.fn().mockResolvedValue("ok");
    usePulls.setState({
      replyThread,
      prPendingActions: [],
      prThreads: {
        [pr.num]: [
          {
            id: "thread-reply",
            path: "src/store/pulls.ts",
            line: 252,
            isResolved: false,
            isOutdated: false,
            commentsTruncated: false,
            comments: [
              {
                author: { name: "reviewer", login: "reviewer" },
                body: "needs a reply",
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      },
    });

    render(<ReviewThreads pr={pr} />);
    await user.type(screen.getByPlaceholderText("Reply..."), "Fixed in this patch");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(replyThread).toHaveBeenCalledWith(pr.num, "thread-reply", "Fixed in this patch");
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
  });

  it("posts a reply on Ctrl/Cmd+Enter from the textarea", async () => {
    const user = userEvent.setup();
    const pr = makePr({ state: "open" });
    const replyThread = vi.fn().mockResolvedValue("ok");
    usePulls.setState({
      replyThread,
      prPendingActions: [],
      prThreads: { [pr.num]: [thread("thread-key", "needs a reply")] },
    });

    render(<ReviewThreads pr={pr} />);
    await user.type(screen.getByPlaceholderText("Reply..."), "Done{Control>}{Enter}{/Control}");

    expect(replyThread).toHaveBeenCalledWith(pr.num, "thread-key", "Done");
    expect(screen.getByPlaceholderText("Reply...")).toHaveValue("");
  });

  it("keeps resolve pending state scoped to the clicked thread", async () => {
    const user = userEvent.setup();
    const pr = makePr({ state: "open" });
    let finishResolve!: (value: string) => void;
    const slowResolve = new Promise<string>((resolve) => {
      finishResolve = resolve;
    });
    const resolveThread = vi.fn().mockReturnValue(slowResolve);
    usePulls.setState({
      resolveThread,
      prPendingActions: [],
      prThreads: {
        [pr.num]: [
          thread("thread-a", "first"),
          thread("thread-b", "second"),
        ],
      },
    });

    render(<ReviewThreads pr={pr} />);
    const buttons = screen.getAllByRole("button", { name: "Resolve conversation" });

    await user.click(buttons[0]);

    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
    expect(resolveThread).toHaveBeenCalledWith(pr.num, "thread-a", true);

    finishResolve("ok");
    await waitFor(() => expect(buttons[0]).not.toBeDisabled());
  });
});

const thread = (id: string, body: string): ReviewThread => ({
  id,
  path: "src/store/pulls.ts",
  line: 1,
  isResolved: false,
  isOutdated: false,
  commentsTruncated: false,
  comments: [
    {
      author: { name: "reviewer", login: "reviewer" },
      body,
      createdAt: new Date().toISOString(),
    },
  ],
});
