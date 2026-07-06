import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { FileDiff } from "./git";
import { parse } from "./validate";
import {
  fileDiffSchema,
  githubAccountSchema,
  prCheckSchema,
  prCommitSchema,
  pullRequestDetailSchema,
  pullRequestSummarySchema,
  reviewThreadSchema,
  githubSignInResultSchema,
} from "./schemas";

export type GithubAuthProvider = "gh" | "native";

/** Result of an in-app `gh auth login --web` sign-in (GL-106). No token. */
export interface GithubSignInResult {
  host: string;
  login: string;
}

export interface GithubAccount {
  provider: GithubAuthProvider;
  host: string;
  accountId: string;
  login: string;
  username: string;
  name: string;
  email: string;
  id: number;
  active: boolean;
  /** False when `gh auth status` reported the credentials as broken (revoked/
   * expired token, or the check timed out) — surfaced as "needs re-auth". */
  healthy: boolean;
  /** Failure detail when `healthy` is false; empty otherwise. */
  healthError: string;
}

export interface GithubAccountRef {
  provider: GithubAuthProvider;
  host: string;
  accountId: string;
  login: string;
}

export interface PrAuthor {
  login: string;
  name: string;
}

export interface PrCheck {
  name: string;
  state: "pass" | "fail" | "pending" | "skipped";
}

/** Raw gh state value. */
export type PrStateRaw = "OPEN" | "MERGED" | "CLOSED";

export interface PullRequestSummary {
  number: number;
  title: string;
  state: PrStateRaw;
  headRef: string;
  baseRef: string;
  author: PrAuthor;
  createdAt: string; // ISO-8601
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  url: string;
  /** Mergeability verdict ("UNKNOWN" until GitHub computes it). */
  mergeable: Mergeable;
}

export interface PrComment {
  author: PrAuthor;
  body: string;
  createdAt: string; // ISO-8601
}

/** A commit included in a PR, sourced from GitHub (the authoritative set). */
export interface PrCommit {
  /** Full commit SHA. */
  oid: string;
  /** First line of the commit message. */
  headline: string;
  authoredDate: string; // ISO-8601
  /** Display name; falls back to login, then "" when GitHub has no author. */
  authorName: string;
  /** GitHub login; "" when unknown. */
  authorLogin: string;
  /** GitHub's own `signature.isValid` — never inferred. `false` for unsigned
   * commits and for the fast-path `gh pr view` list until the paginated commit
   * read replaces it. */
  verified: boolean;
}

/** An inline review thread (file/line-anchored comments + resolve state). */
export interface ReviewThread {
  /** GraphQL node id — used to resolve/unresolve. */
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  /** True when the thread holds more comments than the backend's per-thread
   * fetch cap — the list below is incomplete and the UI should say so. */
  commentsTruncated: boolean;
  comments: PrComment[];
}

/** gh mergeability verdict; "" when unresolved. */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | "";

export interface PrLabel {
  name: string;
  /** 6-hex RGB without the leading `#`. */
  color: string;
}

/** Raw gh review verdict. */
export type ReviewStateRaw =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export interface PrReview {
  author: PrAuthor;
  state: ReviewStateRaw;
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  comments: number;
  files: string[];
  commentList: PrComment[];
  mergeable: Mergeable;
  /** Requested reviewers still pending. */
  reviewers: PrAuthor[];
  /** Submitted reviews (deduped to latest-per-author in the view model). */
  reviews: PrReview[];
  assignees: PrAuthor[];
  labels: PrLabel[];
  milestone: string | null;
  /** Commits in GitHub's order (oldest → newest). */
  commits: PrCommit[];
}

/** Merge strategy passed to `gh pr merge`. */
export type MergeMethod = "merge" | "squash" | "rebase";
/** Review verdict passed to `gh pr review`. */
export type ReviewAction = "approve" | "request-changes" | "comment";
/** Lifecycle transition passed to `gh pr {close,reopen,ready}`. */
export type PrStateAction = "close" | "reopen" | "ready";

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
  ): Promise<PrCommit[]> =>
    parse(
      z.array(prCommitSchema),
      await invoke("pull_request_commits", { path, number, account: account ?? null }),
      "pull_request_commits",
    ),

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
  ): Promise<ReviewThread[]> =>
    parse(
      z.array(reviewThreadSchema),
      await invoke("pull_request_review_threads", { path, number, account: account ?? null }),
      "pull_request_review_threads",
    ),

  /** Resolve (or unresolve) a review thread by its GraphQL node id. */
  resolveReviewThread: (
    path: string,
    threadId: string,
    resolved: boolean,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("resolve_review_thread", {
      path,
      threadId,
      resolved,
      account: account ?? null,
    }),

  /** Add a reply to an existing review thread. */
  replyReviewThread: (
    path: string,
    threadId: string,
    body: string,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("reply_review_thread", {
      path,
      threadId,
      body,
      account: account ?? null,
    }),

  /** Merge a PR via the bound account. Returns gh's confirmation output. */
  mergePullRequest: (
    path: string,
    number: number,
    method: MergeMethod,
    deleteBranch: boolean,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("merge_pull_request", {
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

  /** Open a new PR from `head` into `base`. Returns the new PR URL. */
  createPullRequest: (
    path: string,
    base: string,
    head: string,
    title: string,
    body: string,
    draft: boolean,
    account?: GithubAccountRef | null,
  ) =>
    invoke<string>("create_pull_request", {
      path,
      base,
      head,
      title,
      body,
      draft,
      account: account ?? null,
    }),
};
