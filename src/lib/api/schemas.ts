// Runtime schemas for the high-traffic IPC responses (GL-57). The `lib/api`
// wrappers parse `invoke()` results through these so a serde-struct/TS-interface
// drift surfaces as a clear IpcValidationError at the seam instead of an
// undefined-access crash inside a component.
//
// The schema is the runtime source of truth; the hand-written, documented
// interface (under `git/types/` / in `github.ts`) stays the *type* source of truth so its
// rich field docs survive. The `assertEqual` guards at the bottom fail the build
// if the two ever diverge — so a field added to one must be added to the other.
//
// Unknown fields are *stripped*, not rejected: these objects use Zod's default
// `.strip()` (no `.strict()`) deliberately. A newer backend that adds a field
// must not throw on an older frontend — forward-compat is preferred over
// fail-fast here. Drift that actually matters (a field a consumer relies on)
// still can't slip through: `assertEqual` fails the build when schema and
// interface diverge. The strip only silences backend-only additions the
// frontend doesn't read yet, which is the safe direction to be lenient in.

import { z } from "zod";
import { emptyAdvancedState } from "@/lib/advancedRepoState";
import type {
  AdvancedRepoState,
  CommitNode,
  DiffHunk,
  DiffLine,
  FileAdvancedState,
  FileChange,
  FileDiff,
  GraphEdge,
  HistorySearchPage,
  HistorySearchResult,
  LfsState,
  RefLabel,
  RepoGraph,
  SparseCheckoutState,
  StashRef,
  SubmoduleState,
  WorkingChanges,
} from "./git";
import type {
  GithubAccount,
  Mergeable,
  PrAuthor,
  PrCheck,
  PrComment,
  PrCommit,
  PrCommitList,
  PrLabel,
  PrReview,
  PrStack,
  PrStackEntry,
  PrStackMembership,
  PullRequestDetail,
  PullRequestSummary,
  ReviewThread,
  ReviewThreadList,
} from "./github";

// ---- commit_graph → RepoGraph ----

const refLabelSchema = z.object({
  name: z.string(),
  kind: z.enum(["branch", "remote", "tag", "head"]),
  targetOid: z.string().nullish(),
});

const stashRefSchema = z.object({
  index: z.number(),
  message: z.string(),
});

const commitNodeSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  body: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
  parents: z.array(z.string()),
  lane: z.number(),
  row: z.number(),
  refs: z.array(refLabelSchema),
  stash: stashRefSchema.nullish(),
});

const graphEdgeSchema = z.object({
  fromRow: z.number(),
  fromLane: z.number(),
  toRow: z.number(),
  toLane: z.number(),
  parentIndex: z.number(),
  color: z.number(),
});

export const repoGraphSchema = z.object({
  commits: z.array(commitNodeSchema),
  edges: z.array(graphEdgeSchema),
  laneCount: z.number(),
  wipLane: z.number().nullish(),
  head: z.string().nullable(),
  truncated: z.boolean(),
});

export const historySearchResultSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  summary: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  timestamp: z.number(),
});

export const historySearchPageSchema = z.object({
  results: z.array(historySearchResultSchema),
  truncated: z.boolean(),
  workTruncated: z.boolean(),
});

// ---- working_changes → WorkingChanges ----

const fileStatusSchema = z.enum(["M", "A", "D", "R", "C", "T", "U", "X"]);

const fileAdvancedStateSchema = z.object({
  kind: z.enum(["submodule", "sparse"]),
  message: z.string(),
});

const fileChangeSchema = z.object({
  path: z.string(),
  status: fileStatusSchema,
  add: z.number(),
  del: z.number(),
  binary: z.boolean(),
  lineCountTruncated: z.boolean().optional(),
  previousPath: z.string().optional(),
  advanced: fileAdvancedStateSchema.optional(),
});

const submoduleStateSchema = z.object({
  path: z.string(),
  name: z.string(),
  url: z.string().nullish(),
  status: z.string(),
  details: z.array(z.string()),
  dirty: z.boolean(),
  initialized: z.boolean(),
});

const lfsStateSchema = z.object({
  detected: z.boolean(),
  installed: z.boolean().nullable(),
  issues: z.array(z.string()),
  patterns: z.array(z.string()),
});

const sparseCheckoutStateSchema = z.object({
  enabled: z.boolean(),
  mode: z.string().nullable(),
  patterns: z.array(z.string()),
  truncated: z.boolean().optional(),
});

const advancedRepoStateSchema = z.object({
  submodules: z.array(submoduleStateSchema),
  lfs: lfsStateSchema,
  sparseCheckout: sparseCheckoutStateSchema,
});

export const workingChangesSchema = z.object({
  staged: z.array(fileChangeSchema),
  unstaged: z.array(fileChangeSchema),
  // The backend always sends `conflicted`, but default it so a malformed/legacy
  // payload still normalizes to [] (the long-standing defensive contract) rather
  // than throwing — every consumer can keep relying on the field being present.
  conflicted: z.array(fileChangeSchema).default([]),
  // Always sent by the backend; defaulted (like `conflicted`) so a malformed or
  // legacy payload still normalizes to an empty advanced state rather than
  // throwing, while the parsed type stays non-optional.
  advanced: advancedRepoStateSchema.default(emptyAdvancedState),
});

// ---- file_diff (and the commit/range/compare variants) → FileDiff ----

const diffLineSchema = z.object({
  kind: z.enum(["ctx", "add", "del"]),
  oldNo: z.number().nullable(),
  newNo: z.number().nullable(),
  content: z.string(),
});

const diffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(diffLineSchema),
});

export const fileDiffSchema = z.object({
  path: z.string(),
  status: fileStatusSchema,
  add: z.number(),
  del: z.number(),
  binary: z.boolean(),
  hunks: z.array(diffHunkSchema),
  truncated: z.boolean(),
  oldSize: z.number().optional(),
  newSize: z.number().optional(),
  oldOid: z.string().optional(),
  newOid: z.string().optional(),
  commitOid: z.string().optional(),
  commitSubject: z.string().optional(),
});

// ---- pull_request_detail → PullRequestDetail ----

const prAuthorSchema = z.object({
  login: z.string(),
  name: z.string(),
});

const mergeableSchema = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN", ""]);

const prCommentSchema = z.object({
  author: prAuthorSchema,
  body: z.string(),
  createdAt: z.string(),
});

export const prCommitSchema = z.object({
  oid: z.string(),
  headline: z.string(),
  authoredDate: z.string(),
  authorName: z.string(),
  authorLogin: z.string(),
  verified: z.boolean(),
});

export const prCommitListSchema = z.object({
  commits: z.array(prCommitSchema),
  truncated: z.boolean(),
});

const checksSchema = z.enum(["SUCCESS", "PENDING", "EXPECTED", "FAILURE", "ERROR", ""]);

export const prStackEntrySchema = z.object({
  position: z.number(),
  number: z.number(),
  title: z.string(),
  // Lenient for the same reason as `mergeState` below: the caller treats a
  // failed stack read as "not stacked", so one unexpected enum value would make
  // the whole card silently vanish. Degrading a single field is the smaller lie.
  state: z.enum(["OPEN", "MERGED", "CLOSED"]).catch("OPEN"),
  isDraft: z.boolean(),
  headRef: z.string(),
  mergeable: mergeableSchema.catch("UNKNOWN"),
  // Non-exhaustive on purpose: GitHub can add a state, and an unrecognised one
  // must not fail the whole stack read. It degrades to "", which the view model
  // reads as "nothing failing".
  checks: checksSchema.catch(""),
});

export const prStackMembershipSchema = z.object({
  prNumber: z.number(),
  stackNumber: z.number(),
  position: z.number(),
  size: z.number(),
});

export const prStackSchema = z.object({
  number: z.number(),
  size: z.number(),
  baseRef: z.string(),
  position: z.number(),
  entries: z.array(prStackEntrySchema),
});

const prReviewSchema = z.object({
  author: prAuthorSchema,
  // The Rust side documents `state` as the raw, non-exhaustive gh value. A
  // state this build doesn't know degrades to the neutral COMMENTED (matching
  // `lowerReviewState`'s fallback) instead of failing the whole PR detail.
  state: z
    .enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"])
    .catch("COMMENTED"),
});

const prLabelSchema = z.object({
  name: z.string(),
  color: z.string(),
});

export const pullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  headRef: z.string(),
  baseRef: z.string(),
  author: prAuthorSchema,
  createdAt: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  isDraft: z.boolean(),
  url: z.string(),
  mergeable: mergeableSchema,
});

export const pullRequestDetailSchema = pullRequestSummarySchema.extend({
  body: z.string(),
  comments: z.number(),
  files: z.array(z.string()),
  commentList: z.array(prCommentSchema),
  reviewers: z.array(prAuthorSchema),
  reviews: z.array(prReviewSchema),
  assignees: z.array(prAuthorSchema),
  labels: z.array(prLabelSchema),
  milestone: z.string().nullable(),
  commits: z.array(prCommitSchema),
});

// ---- github_accounts → GithubAccount[] ----

export const githubAccountSchema = z.object({
  provider: z.enum(["gh", "native"]),
  host: z.string(),
  accountId: z.string(),
  login: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string(),
  id: z.number(),
  active: z.boolean(),
  healthy: z.boolean(),
  healthError: z.string(),
});

// ---- github_sign_in → GithubSignInResult ----

export const githubSignInResultSchema = z.object({
  host: z.string(),
  login: z.string(),
});

// ---- pull_request_checks → PrCheck[] ----

export const prCheckSchema = z.object({
  name: z.string(),
  // The Rust side normalizes gh's rollup values into these four buckets today,
  // but a newer backend may grow a fifth. Degrade an unknown bucket to the
  // neutral "pending" instead of failing the whole Checks tab (GL-112).
  state: z.enum(["pass", "fail", "pending", "skipped"]).catch("pending"),
});

// ---- pull_request_review_threads → ReviewThread[] ----

export const reviewThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  commentsTruncated: z.boolean(),
  comments: z.array(prCommentSchema),
});

export const reviewThreadListSchema = z.object({
  threads: z.array(reviewThreadSchema),
  truncated: z.boolean(),
});

// ---- compile-time guards: schema output ≡ documented interface ----
// `assertEqual<A, B>()` only typechecks when A and B are the *same* type, so a
// drift between a schema and its hand-written interface (a renamed/added/removed
// field, a changed nullability) fails `tsc` here — the build-time half of the
// contract that the runtime `parse` enforces dynamically.

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertEqual<_A, _B>(_proof: Equals<_A, _B> extends true ? true : never): void {}

assertEqual<z.infer<typeof refLabelSchema>, RefLabel>(true);
assertEqual<z.infer<typeof stashRefSchema>, StashRef>(true);
assertEqual<z.infer<typeof commitNodeSchema>, CommitNode>(true);
assertEqual<z.infer<typeof graphEdgeSchema>, GraphEdge>(true);
assertEqual<z.infer<typeof repoGraphSchema>, RepoGraph>(true);
assertEqual<z.infer<typeof historySearchPageSchema>, HistorySearchPage>(true);
assertEqual<z.infer<typeof historySearchResultSchema>, HistorySearchResult>(true);

assertEqual<z.infer<typeof fileAdvancedStateSchema>, FileAdvancedState>(true);
assertEqual<z.infer<typeof fileChangeSchema>, FileChange>(true);
assertEqual<z.infer<typeof submoduleStateSchema>, SubmoduleState>(true);
assertEqual<z.infer<typeof lfsStateSchema>, LfsState>(true);
assertEqual<z.infer<typeof sparseCheckoutStateSchema>, SparseCheckoutState>(true);
assertEqual<z.infer<typeof advancedRepoStateSchema>, AdvancedRepoState>(true);
assertEqual<z.infer<typeof workingChangesSchema>, WorkingChanges>(true);

assertEqual<z.infer<typeof diffLineSchema>, DiffLine>(true);
assertEqual<z.infer<typeof diffHunkSchema>, DiffHunk>(true);
assertEqual<z.infer<typeof fileDiffSchema>, FileDiff>(true);

assertEqual<z.infer<typeof prAuthorSchema>, PrAuthor>(true);
assertEqual<z.infer<typeof mergeableSchema>, Mergeable>(true);
assertEqual<z.infer<typeof prCommentSchema>, PrComment>(true);
assertEqual<z.infer<typeof prCommitSchema>, PrCommit>(true);
assertEqual<z.infer<typeof prCommitListSchema>, PrCommitList>(true);
assertEqual<z.infer<typeof prStackEntrySchema>, PrStackEntry>(true);
assertEqual<z.infer<typeof prStackSchema>, PrStack>(true);
assertEqual<z.infer<typeof prStackMembershipSchema>, PrStackMembership>(true);
assertEqual<z.infer<typeof prReviewSchema>, PrReview>(true);
assertEqual<z.infer<typeof prLabelSchema>, PrLabel>(true);
assertEqual<z.infer<typeof pullRequestSummarySchema>, PullRequestSummary>(true);
assertEqual<z.infer<typeof pullRequestDetailSchema>, PullRequestDetail>(true);

assertEqual<z.infer<typeof githubAccountSchema>, GithubAccount>(true);
assertEqual<z.infer<typeof prCheckSchema>, PrCheck>(true);
assertEqual<z.infer<typeof reviewThreadSchema>, ReviewThread>(true);
assertEqual<z.infer<typeof reviewThreadListSchema>, ReviewThreadList>(true);
