import { invoke } from "@tauri-apps/api/core";
import type { FileDiff } from "./git";

export type GithubAuthProvider = "gh" | "native";

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
}

export interface PrComment {
  author: PrAuthor;
  body: string;
  createdAt: string; // ISO-8601
}

/** Per-commit signature verification (GraphQL), loaded lazily for the Commits
 * tab. `verified` is GitHub's own `signature.isValid` — never inferred. */
export interface PrCommitSignature {
  oid: string;
  verified: boolean;
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
}

/** An inline review thread (file/line-anchored comments + resolve state). */
export interface ReviewThread {
  /** GraphQL node id — used to resolve/unresolve. */
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
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
  githubAccounts: () => invoke<GithubAccount[]>("github_accounts"),

  /** Pull requests for the repo, fetched as the bound `account` if given. */
  listPullRequests: (path: string, account?: GithubAccountRef | null) =>
    invoke<PullRequestSummary[]>("list_pull_requests", { path, account: account ?? null }),

  /** Detail (body, files, comment count) for one pull request — no checks. */
  pullRequestDetail: (path: string, number: number, account?: GithubAccountRef | null) =>
    invoke<PullRequestDetail>("pull_request_detail", { path, number, account: account ?? null }),

  /** CI/status checks for a PR (the slow field), loaded lazily on demand. */
  pullRequestChecks: (path: string, number: number, account?: GithubAccountRef | null) =>
    invoke<PrCheck[]>("pull_request_checks", { path, number, account: account ?? null }),

  /** Per-commit signature verification (GraphQL), loaded lazily on demand. */
  pullRequestCommitSignatures: (path: string, number: number, account?: GithubAccountRef | null) =>
    invoke<PrCommitSignature[]>("pull_request_commit_signatures", {
      path,
      number,
      account: account ?? null,
    }),

  /** Full unified diff of a PR (parsed server-side), loaded lazily on demand. */
  pullRequestDiff: (path: string, number: number, account?: GithubAccountRef | null) =>
    invoke<FileDiff[]>("pull_request_diff", { path, number, account: account ?? null }),

  /** Inline review threads for a PR (GraphQL), loaded lazily on demand. */
  pullRequestReviewThreads: (path: string, number: number, account?: GithubAccountRef | null) =>
    invoke<ReviewThread[]>("pull_request_review_threads", {
      path,
      number,
      account: account ?? null,
    }),

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
