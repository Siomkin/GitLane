// Pull-request view model + adapters. Real PR data comes from the `gh` CLI via
// the Rust layer (see api.listPullRequests / pullRequestDetail); this module
// maps those API shapes onto the UI shape the PR list + detail render, and
// holds the small pure helpers they share.

import type {
  Mergeable,
  PrAuthor as ApiPrAuthor,
  PrComment as ApiPrComment,
  PrCommit as ApiPrCommit,
  PrCommitSignature as PrCommitSignatureApi,
  PrLabel,
  PrReview,
  PrStateRaw,
  PullRequestDetail,
  PullRequestSummary,
} from "./api";

export type PrState = "open" | "merged" | "closed";

/** Active tab in the PR list. Canonical here (lib has no store dependency); the
 * UI store imports it so the union has a single source of truth. */
export type PrFilter = "open" | "closed" | "all";

/** Display label per PR state. Shared by the docked list and the detail header
 * so they never drift. State colors come from Tailwind class maps in the PR
 * components, not from here. */
export const PR_META: Record<PrState, { label: string }> = {
  open: { label: "Open" },
  merged: { label: "Merged" },
  closed: { label: "Closed" },
};

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
}

/** Reviewer state as the UI renders it: a submitted verdict or still pending. */
export type ReviewerState = "approved" | "changes_requested" | "commented" | "pending";

/** A reviewer chip: who, plus their latest verdict (or pending). */
export interface Reviewer {
  name: string;
  initials: string;
  state: ReviewerState;
}

/** A label chip: name + the raw hex color (no `#`). */
export interface PrLabelView {
  name: string;
  color: string;
}

/** A commit row as the UI renders it. `oid` is the full SHA (copied verbatim);
 * `shortOid` is the 7-char display form. `hasAuthor` is false when GitHub
 * returned no author metadata, so the UI can show a fallback. `url` is the
 * commit's GitHub page (empty when it can't be derived from the PR url). */
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

export interface PullRequest {
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
  files: string[];
  comments: number;
  /** Raw markdown body (empty for list summaries; filled by the detail fetch). */
  body: string;
  /** Web URL on GitHub (for the "Open on GitHub" action). */
  url: string;
  /** Discussion comments (empty for list summaries; filled by the detail fetch). */
  commentList: PrComment[];
  /** gh mergeability verdict ("" until detail loads). Drives the merge button. */
  mergeable: Mergeable;
  /** Reviewers + verdicts, merged from requested reviewers and submitted reviews. */
  reviewers: Reviewer[];
  assignees: PrAuthor[];
  labels: PrLabelView[];
  milestone: string | null;
  /** Commits in GitHub's order (empty for list summaries; filled by detail). */
  commits: PrCommitView[];
  /** Everyone involved (author + assignees + reviewers + commenters), deduped. */
  participants: PrAuthor[];
}

/** 1–2 letter avatar initials from a display name (falling back to login). */
export function initials(name: string, login: string): string {
  const base = (name || login || "").trim();
  if (!base) return "?";
  const parts = base.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/** Compact relative age ("2h", "3d", "5mo") from an ISO timestamp. */
export function relativeAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  return formatRelativeSeconds(Math.max(0, (Date.now() - then) / 1000));
}

function formatRelativeSeconds(s: number): string {
  if (s < 60) return `${Math.floor(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(mo / 12)}y`;
}

function prStateLower(raw: PrStateRaw): PrState {
  return raw === "OPEN" ? "open" : raw === "MERGED" ? "merged" : "closed";
}

function uiAuthor(a: ApiPrAuthor): PrAuthor {
  const name = a.name || a.login || "unknown";
  return { name, login: a.login, initials: initials(a.name, a.login) };
}

function uiComment(c: ApiPrComment): PrComment {
  return { author: uiAuthor(c.author), body: c.body, age: relativeAge(c.createdAt) };
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
    out.push({ name: login, initials: initials(login, login), state: lowerReviewState(state) });
  }
  for (const a of requested) {
    if (stateByLogin.has(a.login)) continue;
    out.push({ name: a.name || a.login, initials: initials(a.name, a.login), state: "pending" });
  }
  return out;
}

function uiLabel(l: PrLabel): PrLabelView {
  return { name: l.name, color: l.color };
}

/** A commit's GitHub page, derived from the PR's web url by swapping the
 * `/pull/<n>` segment for `/commit/<oid>`. Works for github.com and GHE hosts.
 * Returns "" when the PR url is missing or unrecognised (e.g. list summaries). */
export function commitUrl(prUrl: string, oid: string): string {
  const i = prUrl.lastIndexOf("/pull/");
  if (i === -1 || !oid) return "";
  return `${prUrl.slice(0, i)}/commit/${oid}`;
}

/** API commit → UI row. `hasAuthor` is false only when GitHub returned no
 * author at all (both name and login empty), so the row can fall back. `prUrl`
 * is the parent PR's web url, used to derive the per-commit GitHub link. */
function uiCommit(c: ApiPrCommit, prUrl: string): PrCommitView {
  const hasAuthor = !!(c.authorName || c.authorLogin);
  return {
    oid: c.oid,
    shortOid: c.oid.slice(0, 7),
    headline: c.headline,
    age: relativeAge(c.authoredDate),
    author: {
      name: c.authorName || c.authorLogin || "Unknown author",
      login: c.authorLogin,
      initials: hasAuthor ? initials(c.authorName, c.authorLogin) : "?",
    },
    hasAuthor,
    url: commitUrl(prUrl, c.oid),
    verified: false,
  };
}

/** Merge lazily-fetched signature verification into a commit list, returning a
 * new array (commits stay in order). Verified flips true only for oids GitHub
 * reports as validly signed. */
export function applyCommitSignatures(
  commits: PrCommitView[],
  signatures: PrCommitSignatureApi[],
): PrCommitView[] {
  const verifiedByOid = new Map(signatures.map((s) => [s.oid, s.verified]));
  return commits.map((c) => {
    const verified = verifiedByOid.get(c.oid) ?? false;
    return verified === c.verified ? c : { ...c, verified };
  });
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

/** API list item → UI shape (files/checks/body filled in by the detail fetch). */
export function summaryToPr(s: PullRequestSummary): PullRequest {
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
    files: [],
    comments: 0,
    body: "",
    url: s.url,
    commentList: [],
    mergeable: "",
    reviewers: [],
    assignees: [],
    labels: [],
    milestone: null,
    commits: [],
    participants: [],
  };
}

/** API detail → fully-populated UI shape (checks load separately). */
export function detailToPr(d: PullRequestDetail): PullRequest {
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
    commits: d.commits.map((c) => uiCommit(c, d.url)),
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
export function selectVisiblePrs(prs: PullRequest[], filter: PrFilter): PullRequest[] {
  return prs.filter((p) =>
    filter === "all" ? true : filter === "open" ? p.state === "open" : p.state !== "open",
  );
}

/** Compact "x ago" age from an epoch-ms timestamp (for last-fetched labels). */
export function relativeSince(ms: number, now = Date.now()): string {
  return formatRelativeSeconds(Math.max(0, (now - ms) / 1000));
}
