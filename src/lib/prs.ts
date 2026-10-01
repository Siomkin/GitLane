// Pull-request view model + adapters. Real PR data comes from the `gh` CLI via
// the Rust layer (see api.listPullRequests / pullRequestDetail); this module
// maps those API shapes onto the UI shape the PR list + detail render, and
// holds the small pure helpers they share.

import type {
  Mergeable,
  PrAuthor as ApiPrAuthor,
  PrComment as ApiPrComment,
  PrCommit as ApiPrCommit,
  PrLabel,
  PrReview,
  PrStateRaw,
  PullRequestDetail,
  PullRequestSummary,
  RepoForge,
} from "./api";
import { commitWebUrl } from "./forgeUrls";
import { ageParts } from "./relativeTime";
import { initials } from "./ui";

/** The lifecycle states a pull request can be in. One source of truth: the
 * union is derived from it, so a comparison can name a state instead of
 * spelling a bare literal. */
export const PR_STATE = { Open: "open", Merged: "merged", Closed: "closed" } as const;
export type PrState = (typeof PR_STATE)[keyof typeof PR_STATE];

/** Active tab in the PR list. Canonical here (lib has no store dependency); the
 * UI store imports it so the union has a single source of truth. */
export type PrFilter = "open" | "closed" | "all";

/** Author as the UI renders it: display name + avatar initials. `login` is the
 * stable GitHub handle (kept for identity — display names aren't unique and can
 * be empty on comment authors, so dedupe/compare on this, not `name`). */
export interface PrAuthor {
  name: string;
  login: string;
  initials: string;
}

/** A discussion comment as the UI renders it. */
export interface PrComment {
  author: PrAuthor;
  body: string;
  age: string;
  createdAt: string;
}

/** Reviewer state as the UI renders it: a submitted verdict or still pending. */
export type ReviewerState = "approved" | "changes_requested" | "commented" | "pending";

/** A reviewer chip: who, plus their latest verdict (or pending). */
export interface Reviewer {
  name: string;
  /** Stable identity (keys, dedupe) — display names aren't unique. */
  login: string;
  initials: string;
  state: ReviewerState;
}

/** A label chip: name + the raw hex color (no `#`). */
export interface PrLabelView {
  name: string;
  color: string;
}

/** A commit row as the UI renders it. `oid` is the full SHA (copied verbatim);
 * `shortOid` is the 7-char display form. `hasAuthor` is false when the forge
 * returned no author metadata, so the UI can show a fallback. `url` is the
 * commit's page on the forge (empty when it can't be derived from the PR url). */
export interface PrCommitView {
  oid: string;
  shortOid: string;
  headline: string;
  age: string;
  author: PrAuthor;
  hasAuthor: boolean;
  url: string;
  /** GitHub-verified signature. False until the lazy signature fetch lands (and
   * whenever GitHub reports no valid signature) — never inferred locally. */
  verified: boolean;
}

/** A PR as the list endpoint returns it — the shape the docked rows, badges,
 * and cache-invalidation compares work from. The detail-only fields (file
 * paths, body, reviewers, commits, …) live on `PrDetail`, so a summary can
 * never render their absence as a real 0/""/[]: the fields are simply not
 * there for the compiler to let through. */
export interface PrSummary {
  num: number;
  state: PrState;
  /** Draft PRs can't be merged until marked ready (`gh pr ready`). */
  draft: boolean;
  title: string;
  branch: string;
  base: string;
  author: PrAuthor;
  age: string;
  add: number;
  del: number;
  /** Changed-file count (both list and detail report it). The Diff badge
   * renders this, so a summary-first render shows the real count instead of a
   * false 0 — `files` (the path list) is detail-only. */
  changedFiles: number;
  /** Web URL on GitHub (for the "Open on GitHub" action). */
  url: string;
  /** gh mergeability verdict ("" / "UNKNOWN" until computed). Drives the merge
   * button; the list carries it too, so it lives on the summary. */
  mergeable: Mergeable;
}

/** A fully-loaded PR: everything the list carries plus the ten fields only the
 * detail fetch (`gh pr view` / GraphQL) populates. This is what the store's
 * `prResources.detail` record caches and the Info/Diff/Checks/Commits tab
 * bodies render. */
export interface PrDetail extends PrSummary {
  /** Changed-file paths. */
  files: string[];
  /** Discussion-comment count. */
  comments: number;
  /** Raw markdown body. */
  body: string;
  /** Discussion comments. */
  commentList: PrComment[];
  /** Reviewers + verdicts, merged from requested reviewers and submitted reviews. */
  reviewers: Reviewer[];
  assignees: PrAuthor[];
  labels: PrLabelView[];
  milestone: string | null;
  /** Commits in GitHub's order — the capped fast-path list until the full
   * Commits load replaces it. */
  commits: PrCommitView[];
  /** Everyone involved (author + assignees + reviewers + commenters), deduped. */
  participants: PrAuthor[];
}

/** Compact relative age ("2h", "3d", "5mo") from an ISO timestamp. */
export function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  return formatRelativeSeconds(Math.max(0, (Date.now() - then) / 1000));
}

/** "2d" — the shared age boundaries (`lib/relativeTime`), unsuffixed for PR
 * list columns; seconds under a minute. */
function formatRelativeSeconds(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  const { value, short } = ageParts(s);
  return `${value}${short}`;
}

function prStateLower(raw: PrStateRaw): PrState {
  return raw === "OPEN" ? "open" : raw === "MERGED" ? "merged" : "closed";
}

/** API person → UI author. Exported for review-thread comments, which arrive
 * login-only and must compare by `login` like every other PR person. */
export function uiAuthor(a: ApiPrAuthor): PrAuthor {
  const name = a.name || a.login || "unknown";
  return { name, login: a.login, initials: initials(a.name || a.login) };
}

function uiComment(c: ApiPrComment): PrComment {
  return {
    author: uiAuthor(c.author),
    body: c.body,
    age: relativeAge(c.createdAt),
    createdAt: c.createdAt,
  };
}

function lowerReviewState(raw: PrReview["state"]): ReviewerState {
  return raw === "APPROVED"
    ? "approved"
    : raw === "CHANGES_REQUESTED"
      ? "changes_requested"
      : "commented";
}

/** Merge requested reviewers with submitted reviews into one chip list: each
 * reviewer once, with their latest verdict, and still-requested reviewers shown
 * as pending. `reviews` is chronological, so later entries win. */
function uiReviewers(requested: ApiPrAuthor[], reviews: PrReview[]): Reviewer[] {
  const stateByLogin = new Map<string, PrReview["state"]>();
  for (const r of reviews) {
    if (r.author.login && r.state !== "DISMISSED" && r.state !== "PENDING") {
      stateByLogin.set(r.author.login, r.state);
    }
  }
  const out: Reviewer[] = [];
  for (const [login, state] of stateByLogin) {
    out.push({ name: login, login, initials: initials(login), state: lowerReviewState(state) });
  }
  for (const a of requested) {
    if (stateByLogin.has(a.login)) continue;
    out.push({ name: a.name || a.login, login: a.login, initials: initials(a.name || a.login), state: "pending" });
  }
  return out;
}

function uiLabel(l: PrLabel): PrLabelView {
  return { name: l.name, color: l.color };
}

/** API commit → UI row. `hasAuthor` is false only when GitHub returned no
 * author at all (both name and login empty), so the row can fall back. The
 * per-commit link is the repo forge's own commit page (`commitWebUrl`), so
 * GitLab and Bitbucket rows link too; "" when the forge has no web URL. */
function uiCommit(c: ApiPrCommit, forge: RepoForge | null): PrCommitView {
  const hasAuthor = !!(c.authorName || c.authorLogin);
  return {
    oid: c.oid,
    shortOid: c.oid.slice(0, 7),
    headline: c.headline,
    age: relativeAge(c.authoredDate),
    author: {
      name: c.authorName || c.authorLogin || "Unknown author",
      login: c.authorLogin,
      initials: hasAuthor ? initials(c.authorName || c.authorLogin) : "?",
    },
    hasAuthor,
    url: c.oid ? (commitWebUrl(forge, c.oid) ?? "") : "",
    // `verified` is authoritative from the source: the `gh pr view` fast-path
    // sends `false`; the paginated GraphQL commit read sends GitHub's real value.
    verified: c.verified,
  };
}

/** Map the full API commit list (from the paginated GraphQL read) to UI rows.
 * Replaces the capped `gh pr view` list once the Commits tab loads. */
export function uiCommits(commits: ApiPrCommit[], forge: RepoForge | null): PrCommitView[] {
  return commits.map((c) => uiCommit(c, forge));
}

/** Dedupe a list of people by login (the stable handle), preserving first-seen
 * order. Deduping on display name would double-count someone who appears once
 * with a name (e.g. the PR author) and once login-only (a comment author). */
function dedupePeople(...groups: PrAuthor[][]): PrAuthor[] {
  const seen = new Set<string>();
  const out: PrAuthor[] = [];
  for (const group of groups) {
    for (const p of group) {
      const key = p.login || p.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** API list item → UI summary. No invented sentinels: the detail-only fields
 * are simply absent, so nothing can mistake "detail not loaded yet" for a real
 * 0 / "" / []. */
export function summaryToPr(s: PullRequestSummary): PrSummary {
  return {
    num: s.number,
    state: prStateLower(s.state),
    draft: s.isDraft,
    title: s.title,
    branch: s.headRef,
    base: s.baseRef,
    author: uiAuthor(s.author),
    age: relativeAge(s.createdAt),
    add: s.additions,
    del: s.deletions,
    changedFiles: s.changedFiles,
    url: s.url,
    mergeable: s.mergeable,
  };
}

/** API detail → fully-populated UI detail (checks load separately). `forge` is
 * the open repo's forge, which the commit links are built against. */
export function detailToPr(d: PullRequestDetail, forge: RepoForge | null): PrDetail {
  return {
    ...summaryToPr(d),
    files: d.files,
    comments: d.comments,
    body: d.body,
    commentList: d.commentList.map(uiComment),
    mergeable: d.mergeable,
    reviewers: uiReviewers(d.reviewers, d.reviews),
    assignees: d.assignees.map(uiAuthor),
    labels: d.labels.map(uiLabel),
    milestone: d.milestone,
    commits: d.commits.map((c) => uiCommit(c, forge)),
    participants: dedupePeople(
      [uiAuthor(d.author)],
      d.assignees.map(uiAuthor),
      d.reviewers.map(uiAuthor),
      d.reviews.map((r) => uiAuthor(r.author)),
      d.commentList.map((c) => uiAuthor(c.author)),
    ),
  };
}

/** PR list filtered to the active tab. Shared so the docked list and the detail
 * view never diverge on what "open"/"closed"/"all" means. */
export function selectVisiblePrs(prs: PrSummary[], filter: PrFilter): PrSummary[] {
  return prs.filter((p) =>
    filter === "all" ? true : filter === "open" ? p.state === "open" : p.state !== "open",
  );
}

/** Compact "x ago" age from an epoch-ms timestamp (for last-fetched labels). */
export function relativeSince(ms: number, now = Date.now()): string {
  return formatRelativeSeconds(Math.max(0, (now - ms) / 1000));
}
