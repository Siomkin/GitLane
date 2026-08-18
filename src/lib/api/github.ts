// The GitHub IPC wrappers. The shapes they resolve to live in `github/types`
// and are re-exported here, so consumers keep one import site.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { FileDiff } from "./git";
import { parse } from "./validate";
import {
  fileDiffSchema,
  githubAccountSchema,
  prCheckSchema,
  prCommitListSchema,
  prStackMembershipSchema,
  prStackSchema,
  pullRequestDetailSchema,
  pullRequestSummarySchema,
  reviewThreadListSchema,
  githubSignInResultSchema,
} from "./schemas";

export * from "./github/types";
import type {
  GithubAccount,
  GithubAccountRef,
  GithubSignInResult,
  MergeMethod,
  PrCheck,
  PrCommitList,
  PrCreateInput,
  PrReviewerCandidate,
  PrStack,
  PrStackMembership,
  PrStateAction,
  PullRequestDetail,
  PullRequestMergeOutcome,
  PullRequestSummary,
  ReviewAction,
  ReviewThreadList,
} from "./github/types";

export const githubApi = {
  /** Accounts the `gh` CLI is logged into. Empty when not logged in. */
  githubAccounts: async (): Promise<GithubAccount[]> =>
    parse(z.array(githubAccountSchema), await invoke("github_accounts"), "github_accounts"),

  /** Start the in-app `gh auth login --web` device flow for `host`. Resolves with
   * the newly added account once authorized; emits `github-signin-progress`
   * events meanwhile. Rejects on failure or when cancelled via
   * `cancelGithubSignIn`. */
  githubSignIn: async (host: string): Promise<GithubSignInResult> =>
    parse(githubSignInResultSchema, await invoke("github_sign_in", { host }), "github_sign_in"),

  /** Kill an in-flight `githubSignIn` child (Cancel). Idempotent. */
  cancelGithubSignIn: async (): Promise<void> => {
    await invoke("cancel_github_sign_in");
  },

  /** Sign one account out of `gh` (`gh auth logout`) — removes its
   * credential-store entry. */
  githubSignOut: async (host: string, login: string): Promise<void> => {
    await invoke("github_sign_out", { host, login });
  },

  /** Pull requests for the repo, fetched as the bound `account` if given. */
  listPullRequests: async (
    path: string,
    account?: GithubAccountRef | null,
  ): Promise<PullRequestSummary[]> =>
    parse(
      z.array(pullRequestSummarySchema),
      await invoke("list_pull_requests", { path, account: account ?? null }),
      "list_pull_requests",
    ),

  /** Detail (body, files, comment count) for one pull request — no checks. */
  pullRequestDetail: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<PullRequestDetail> =>
    parse(
      pullRequestDetailSchema,
      await invoke("pull_request_detail", { path, number, account: account ?? null }),
      "pull_request_detail",
    ),

  /** CI/status checks for a PR (the slow field), loaded lazily on demand. */
  pullRequestChecks: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<PrCheck[]> =>
    parse(
      z.array(prCheckSchema),
      await invoke("pull_request_checks", { path, number, account: account ?? null }),
      "pull_request_checks",
    ),

  /** The full, verified PR commit list (GraphQL, paginated), loaded lazily on
   * demand — supersedes the capped `commits` array on the PR detail. */
  pullRequestCommits: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<PrCommitList> =>
    parse(
      prCommitListSchema,
      await invoke("pull_request_commits", { path, number, account: account ?? null }),
      "pull_request_commits",
    ),

  /** The stack this PR belongs to, or `null` when it is not stacked — which is
   * the common case and a successful read, not an error. Stacked pull requests
   * are GitHub-only; other forges always answer `null`. */
  pullRequestStack: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<PrStack | null> =>
    parse(
      prStackSchema.nullable(),
      await invoke("pull_request_stack", { path, number, account: account ?? null }),
      "pull_request_stack",
    ),

  /** Every stack in the repo, flattened per pull request. One call for the whole
   * PR list, rather than a per-row query. Empty on a forge without stacks. */
  repositoryStacks: async (
    path: string,
    account?: GithubAccountRef | null,
  ): Promise<PrStackMembership[]> =>
    parse(
      z.array(prStackMembershipSchema),
      await invoke("repository_stacks", { path, account: account ?? null }),
      "repository_stacks",
    ),

  /** Atomically merge a PR together with every unmerged layer below it in its
   * stack. GitHub runs this asynchronously and the backend polls to a terminal
   * state, so this call can take up to a minute before it resolves. */
  mergePullRequestStack: async (
    path: string,
    number: number,
    method: MergeMethod,
    account?: GithubAccountRef | null,
  ): Promise<string> =>
    invoke("merge_pull_request_stack", { path, number, method, account: account ?? null }),

  /** Full unified diff of a PR (parsed server-side), loaded lazily on demand. */
  pullRequestDiff: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<FileDiff[]> =>
    parse(
      z.array(fileDiffSchema),
      await invoke("pull_request_diff", { path, number, account: account ?? null }),
      "pull_request_diff",
    ),

  /** Inline review threads for a PR (GraphQL), loaded lazily on demand. */
  pullRequestReviewThreads: async (
    path: string,
    number: number,
    account?: GithubAccountRef | null,
  ): Promise<ReviewThreadList> =>
    parse(
      reviewThreadListSchema,
      await invoke("pull_request_review_threads", { path, number, account: account ?? null }),
      "pull_request_review_threads",
    ),

  /** Resolve (or unresolve) a review thread by its GraphQL node id. */
  resolveReviewThread: (
    path: string,
    number: number,
    threadId: string,
    resolved: boolean,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("resolve_review_thread", {
      path,
      number,
      threadId,
      resolved,
      account: account ?? null,
    }),

  /** Add a reply to an existing review thread. */
  replyReviewThread: (
    path: string,
    number: number,
    threadId: string,
    body: string,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("reply_review_thread", {
      path,
      number,
      threadId,
      body,
      account: account ?? null,
    }),

  /** Merge a PR via the bound account. Resolving means the merge landed; the
   * outcome carries what the provider could not finish (GL-345). */
  mergePullRequest: (
    path: string,
    number: number,
    method: MergeMethod,
    deleteBranch: boolean,
    account?: GithubAccountRef | null,
  ) =>
    invoke<PullRequestMergeOutcome>("merge_pull_request", {
      path,
      number,
      method,
      deleteBranch,
      account: account ?? null,
    }),

  /** Post a discussion comment on a PR. */
  commentPullRequest: (path: string, number: number, body: string, account?: GithubAccountRef | null) =>
    invoke<string>("comment_pull_request", { path, number, body, account: account ?? null }),

  /** Submit a review (approve / request-changes / comment). */
  reviewPullRequest: (
    path: string,
    number: number,
    action: ReviewAction,
    body: string,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("review_pull_request", { path, number, action, body, account: account ?? null }),

  /** Close, reopen, or mark a draft PR ready for review. */
  setPullRequestState: (
    path: string,
    number: number,
    action: PrStateAction,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("set_pull_request_state", { path, number, action, account: account ?? null }),

  /** Open a new PR from `input.head` into `input.base`. Returns the new PR URL. */
  createPullRequest: (path: string, input: PrCreateInput, account?: GithubAccountRef | null) =>
    invoke<string>("create_pull_request", { path, input, account: account ?? null }),

  /** Link existing pull requests into a GitHub stack, bottom-first.
   *
   * GitHub's public GraphQL can read `PullRequest.stack` but has no mutation
   * that creates one, so targeting the layer below with `--base` produces the
   * branch chain and nothing else. This runs `gh stack link`, the supported way
   * to make the link. Rejects when the extension is absent, with the install
   * command in the message. */
  linkPullRequestStack: (path: string, numbers: number[], account?: GithubAccountRef | null) =>
    invoke<string>("link_pull_request_stack", { path, numbers, account: account ?? null }),

  /** People who can be asked to review here. Empty for providers without a
   * reviewer lookup, and for a caller without push access — the picker hides
   * rather than erroring. */
  pullRequestReviewerCandidates: (path: string, account?: GithubAccountRef | null) =>
    invoke<PrReviewerCandidate[]>("pull_request_reviewer_candidates", {
      path,
      account: account ?? null,
    }),
};
