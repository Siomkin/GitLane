// The GitHub/PR shapes that cross IPC. Serde renames every Rust field to
// camelCase, so these mirror `git/types/` and `git/forge/` field for field.

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

export interface PrCommitList {
  commits: PrCommit[];
  truncated: boolean;
}

/** One layer of a stacked pull request. `position` is GitHub's 1-based index
 * counted from the trunk, so position 1 targets the stack's base branch. */
export interface PrStackEntry {
  position: number;
  number: number;
  title: string;
  state: PrStateRaw;
  isDraft: boolean;
  headRef: string;
  /** Conflicts only — NOT whether this layer can merge. See `mergeState`. */
  mergeable: Mergeable;
  /** Head commit's `statusCheckRollup` — what GitHub's own stack card renders
   * Ready/Not-ready from. Deliberately not `mergeStateStatus`, which reports
   * BLOCKED for anything the base ruleset still wants (an approving review,
   * say) that GitHub's stack UI does not gate on. `""` when the repo runs no
   * checks, which means "nothing failing". */
  checks: ChecksState;
}

/** GitHub's `StatusState`; "" when the repo runs no checks. */
export type ChecksState = "SUCCESS" | "PENDING" | "EXPECTED" | "FAILURE" | "ERROR" | "";

/** One pull request's place in a stack, for the PR list badge.
 *
 * The list needs this for every row at once, which the per-PR `PrStack` read
 * can't provide — it only covers a PR whose detail is open. */
export interface PrStackMembership {
  prNumber: number;
  stackNumber: number;
  /** 1-based from the trunk, matching `PrStackEntry.position`. */
  position: number;
  size: number;
}

/** The stack a pull request belongs to.
 *
 * `number` comes from the **same sequence as issues and pull requests** — stack
 * 307 and PR 307 are unrelated objects — so it is never rendered as a bare
 * `#307`.
 *
 * `size` is GitHub's own total and may exceed `entries.length` if a stack
 * outgrows the backend's page size; compare the two rather than assuming
 * `entries` is complete. */
export interface PrStack {
  number: number;
  size: number;
  baseRef: string;
  /** The viewed PR's own position within `entries`. */
  position: number;
  /** Bottom-to-top: `entries[0]` is position 1, the layer targeting `baseRef`. */
  entries: PrStackEntry[];
}

/** Everything a new pull request is opened with. One object rather than
 * positional arguments — the backend threads it through service, trait, and
 * three providers, so a new field widens one shape instead of six signatures. */
export interface PrCreateInput {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  /** Provider logins to request review from. Empty when the provider has no
   * reviewer support, or the user picked none. */
  reviewers: string[];
}

/** Someone who can be asked to review in this repository. */
export interface PrReviewerCandidate {
  login: string;
  /** Display name when the provider gives one, else the login. */
  name: string;
  avatarUrl: string | null;
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

export interface ReviewThreadList {
  threads: ReviewThread[];
  truncated: boolean;
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

/** Outcome of a merge that succeeded (GL-345). `undeletedBranch` names the head
 * branch when its deletion was requested and it still exists afterwards — the
 * backend verifies the ref rather than parsing the CLI's output, and reports
 * nothing when it cannot tell, so this is never a false alarm. */
export interface PullRequestMergeOutcome {
  undeletedBranch: string | null;
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
