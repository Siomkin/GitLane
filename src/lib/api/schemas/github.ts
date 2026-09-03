// Runtime schemas for the GitHub / pull-request responses — mirrors
// `github/types.ts`.

import { z } from "zod";
import type {
  ChecksState,
  GithubAccount,
  GithubSignInResult,
  Mergeable,
  PrAuthor,
  PrCheck,
  PrComment,
  PrCommit,
  PrCommitList,
  PrLabel,
  PrReview,
  PrReviewerCandidate,
  PrStack,
  PrStackEntry,
  PrStackMembership,
  PrStateRaw,
  PullRequestDetail,
  PullRequestMergeOutcome,
  PullRequestSummary,
  ReviewStateRaw,
  ReviewThread,
  ReviewThreadList,
} from "@/lib/api/github/types";
import { assertEqual } from "./assertEqual";

const prAuthorSchema = z.object({
  login: z.string(),
  name: z.string(),
});

const mergeableSchema = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN", ""]);

const prStateRawSchema = z.enum(["OPEN", "MERGED", "CLOSED"]);

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
  state: prStateRawSchema.catch("OPEN"),
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

const reviewStateRawSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
]);

const prReviewSchema = z.object({
  author: prAuthorSchema,
  // The Rust side documents `state` as the raw, non-exhaustive gh value. A
  // state this build doesn't know degrades to the neutral COMMENTED (matching
  // `lowerReviewState`'s fallback) instead of failing the whole PR detail.
  state: reviewStateRawSchema.catch("COMMENTED"),
});

const prLabelSchema = z.object({
  name: z.string(),
  color: z.string(),
});

export const pullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  state: prStateRawSchema,
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

export const pullRequestMergeOutcomeSchema = z.object({
  undeletedBranch: z.string().nullable(),
});

export const prReviewerCandidateSchema = z.object({
  login: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

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

export const githubSignInResultSchema = z.object({
  host: z.string(),
  login: z.string(),
});

export const prCheckSchema = z.object({
  name: z.string(),
  // The Rust side normalizes gh's rollup values into these four buckets today,
  // but a newer backend may grow a fifth. Degrade an unknown bucket to the
  // neutral "pending" instead of failing the whole Checks tab (GL-112).
  state: z.enum(["pass", "fail", "pending", "skipped"]).catch("pending"),
});

export const reviewThreadSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  commentsTruncated: z.boolean(),
  diffHunk: z.string().nullable(),
  comments: z.array(prCommentSchema),
});

export const reviewThreadListSchema = z.object({
  threads: z.array(reviewThreadSchema),
  truncated: z.boolean(),
});

assertEqual<z.infer<typeof prAuthorSchema>, PrAuthor>(true);
assertEqual<z.infer<typeof mergeableSchema>, Mergeable>(true);
assertEqual<z.infer<typeof prStateRawSchema>, PrStateRaw>(true);
assertEqual<z.infer<typeof checksSchema>, ChecksState>(true);
assertEqual<z.infer<typeof reviewStateRawSchema>, ReviewStateRaw>(true);
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
assertEqual<z.infer<typeof pullRequestMergeOutcomeSchema>, PullRequestMergeOutcome>(true);
assertEqual<z.infer<typeof prReviewerCandidateSchema>, PrReviewerCandidate>(true);
assertEqual<z.infer<typeof githubAccountSchema>, GithubAccount>(true);
assertEqual<z.infer<typeof githubSignInResultSchema>, GithubSignInResult>(true);
assertEqual<z.infer<typeof prCheckSchema>, PrCheck>(true);
assertEqual<z.infer<typeof reviewThreadSchema>, ReviewThread>(true);
assertEqual<z.infer<typeof reviewThreadListSchema>, ReviewThreadList>(true);
