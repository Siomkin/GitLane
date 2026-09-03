// Pure, framework-free helpers for the repository onboarding flow (GL-38): Git
// URL validation, clone-error classification into actionable copy, recent-repo
// presentation (relative time + avatar), and path math. No React, no IPC — all
// of this is unit-tested in onboarding.test.ts.

import { toCommandError } from "@/lib/api";
import { friendlyGitError } from "@/lib/gitError";
import { httpUrlHasPassword } from "@/lib/remotes";
import { trimTrailingSlash } from "@/lib/worktrees";

/** The seven onboarding screens (mirrors the RepoOnboarding mockup's `screen`). */
export type OnboardingScreen =
  | "home"
  | "clone"
  | "progress"
  | "error"
  | "init"
  | "empty"
  | "opened";

/** How App mounts onboarding: the no-repo start state, or a dismissible overlay
 * raised over a workspace / missing-repo view. Passed explicitly — do not infer
 * it from `onClose`'s presence. */
export const ONBOARDING_MODE = {
  Inline: "inline",
  Overlay: "overlay",
} as const;
export type OnboardingMode = (typeof ONBOARDING_MODE)[keyof typeof ONBOARDING_MODE];

/** The repository a just-completed clone/init produced, shown on the success
 * screen before entering it. Which screen to show (empty after init vs opened
 * after clone) is the orchestrator's `screen` state — not duplicated here. */
export interface OnboardingResult {
  name: string;
  branch: string;
  path: string;
}

export type UrlState = "empty" | "valid" | "invalid";

/** Validate a clone URL and extract the repo name it would produce. Accepts
 * https(s)://, git@host:path, ssh://, and git:// forms — matching what `git
 * clone` understands. */
export function validateCloneUrl(raw: string): { state: UrlState; repo: string } {
  const url = (raw ?? "").trim();
  if (!url) return { state: "empty", repo: "repository" };
  const repo = parseRepoName(url);
  const wellFormed =
    !httpUrlHasPassword(url) &&
    /^(https?:\/\/|git@[\w.-]+:|ssh:\/\/|git:\/\/)[^\s]+/.test(url) &&
    /[/:][\w.-]+(\.git)?\/?$/.test(url);
  // A well-formed URL whose derived folder name is unsafe (e.g. ends in /., /..)
  // can't produce a valid child destination → treat the URL as invalid.
  return { state: wellFormed && isSafeLeafName(repo) ? "valid" : "invalid", repo };
}

/** The repository (leaf) name a clone URL resolves to, sans `.git`. Falls back
 * to "repository" when nothing parseable is present. */
export function parseRepoName(url: string): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  const match = trimmed.match(/([\w.-]+?)(\.git)?$/);
  return match && match[1] ? match[1] : "repository";
}

/** A safe directory leaf name for a new clone/init: non-empty and not a
 * dot-segment (`.`/`..`) or path that would resolve outside the chosen parent.
 * Mirrors the backend `ensure_safe_leaf`. */
export function isSafeLeafName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed !== "" &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

export type CloneErrorKind = "exists" | "auth" | "denied" | "unreachable" | "canceled" | "failed";

/** Actionable copy for a clone failure — title, explanation, the raw git line to
 * show in the terminal block, whether it's a hard failure (red) vs. a benign
 * cancel (neutral), and the retry button's verb. */
export interface CloneErrorCopy {
  kind: CloneErrorKind;
  title: string;
  message: string;
  /** The `fatal:`/`error:` line from git, shown verbatim; "" hides the block. */
  cmd: string;
  /** true → alert-triangle (red); false → x-circle (neutral, used for cancel). */
  fail: boolean;
  retryLabel: string;
  /** Auth-shaped failure the error screen can fix in place: it renders the
   * recovery panel (account pick / token entry / SSH guidance) and retries. */
  recoverable: boolean;
}

/** Map a git clone failure (raw stderr) to actionable copy + a kind the UI uses
 * to decide whether retry re-runs the clone or returns to the form. */
export function classifyCloneError(raw: unknown): CloneErrorCopy {
  // The clone rejection is a `CommandError`: its kind/code drive the friendly
  // transport copy below, while the clone-specific routing (which recovery
  // screen, which retry label) still reads the text — the clone flow
  // deliberately groups "not found" with unreachable and a host-key failure
  // with auth, which differs from the backend's transport codes.
  const error = toCommandError(raw);
  const message = error.message.trim();
  const lower = message.toLowerCase();
  const cmd = fatalLine(message);

  if (lower.includes("already in progress")) {
    return {
      kind: "failed",
      title: "A clone is already running",
      message: "Wait for the current clone to finish before starting another.",
      cmd: "",
      fail: true,
      retryLabel: "Try again",
      recoverable: false,
    };
  }
  if (lower.includes("already exists")) {
    return {
      kind: "exists",
      title: "Destination already exists",
      message:
        "The folder you chose already contains files. Pick an empty directory or a new folder name to clone into.",
      cmd,
      fail: true,
      retryLabel: "Choose another folder",
      recoverable: false,
    };
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("invalid username or password") ||
    // Require the SSH publickey context, not a bare "permission denied": git
    // uses that same phrase for a LOCAL filesystem error ("could not create
    // work tree dir '…': Permission denied"), which is not an auth problem and
    // must not land on the token-entry recovery panel. Real SSH auth failures
    // still recover — they carry "(publickey)" and/or the "could not read from
    // remote repository" line matched below.
    lower.includes("permission denied (publickey") ||
    lower.includes("terminal prompts disabled") ||
    // Git's generic SSH access failure — often the ONLY line in stderr when the
    // key is missing/rejected (the "Permission denied (publickey)" line doesn't
    // always surface). Access problem → the recovery panel applies. Checked
    // before "not found", which the same blob's advice line can also mention.
    lower.includes("could not read from remote repository") ||
    lower.includes("host key verification failed")
  ) {
    const friendly = friendlyGitError(error, { credentialHelp: "generic" });
    return {
      kind: "auth",
      title: "Authentication failed",
      message:
        friendly !== message
          ? friendly
          : "GitLane couldn't authenticate with the remote — the repository needs a credential.",
      cmd,
      fail: true,
      retryLabel: "Retry clone",
      recoverable: true,
    };
  }
  // A 403 is reached-but-refused, not unreachable: the credential was accepted
  // but lacks permission (token scope / repo or workspace access / wrong username
  // convention for the token type). Must be checked before "unable to access",
  // which git prefixes onto the same line.
  if (lower.includes("error: 403") || lower.includes("403 forbidden")) {
    const bitbucket = lower.includes("bitbucket");
    // Servers often say exactly what's wrong on a `remote:` line (Bitbucket's
    // "API Token provided has no Bitbucket scopes.") but git buries it above
    // the fatal: line — surface it instead of the generic guess.
    const said = remoteMessageLine(message);
    return {
      kind: "denied",
      title: "Access denied (403)",
      message:
        (said
          ? `The host refused access: “${said}”`
          : "The host refused access — the credential lacks permission for this repository, or this account can't access it.") +
        // The recovery panel below owns the how (GCM/CLI/SSH), so the headline
        // only names the fix.
        (bitbucket ? " Use Git Credential Manager or SSH for Bitbucket access." : ""),
      cmd,
      fail: true,
      retryLabel: "Retry clone",
      recoverable: true,
    };
  }
  if (
    lower.includes("not found") ||
    lower.includes("could not resolve host") ||
    lower.includes("unable to access") ||
    lower.includes("does not appear to be a git repository") ||
    lower.includes("connection refused") ||
    lower.includes("network is unreachable")
  ) {
    const friendly = friendlyGitError(error, { credentialHelp: "generic" });
    return {
      kind: "unreachable",
      title: "Couldn't reach that repository",
      message:
        friendly !== message
          ? friendly
          : "The remote URL looks wrong or the host can't be reached. Double-check the address and your network connection.",
      cmd,
      fail: true,
      retryLabel: "Edit URL",
      recoverable: false,
    };
  }
  return {
    kind: "failed",
    title: "Clone failed",
    message: message || "The clone didn't finish. Check the URL and try again.",
    cmd,
    fail: true,
    retryLabel: "Try again",
    recoverable: false,
  };
}

/** Copy for a user-canceled clone — a neutral state, not a failure. */
export function canceledCloneCopy(): CloneErrorCopy {
  return {
    kind: "canceled",
    title: "Clone canceled",
    message:
      "The clone was stopped before it finished. No partial repository was left behind — the destination is clean.",
    cmd: "",
    fail: false,
    retryLabel: "Try again",
    recoverable: false,
  };
}

/** Whether an error of `kind` should re-run the clone on retry (auth/denied/
 * canceled/generic) vs. return to the form so the URL/destination can change.
 * `denied` reruns because the recovery panel fixes the credential in place. */
export function retryRerunsClone(kind: CloneErrorKind): boolean {
  return kind === "auth" || kind === "denied" || kind === "canceled" || kind === "failed";
}

/** The first informative `remote:` line of a git failure — the server's own
 * explanation, when it sent one. */
function remoteMessageLine(message: string): string | null {
  for (const line of message.split("\n")) {
    const m = line.trim().match(/^remote:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

/** The most relevant single line of a git failure: the first `fatal:`/`error:`
 * line, else the last non-empty line. */
function fatalLine(message: string): string {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((l) => l.startsWith("fatal:") || l.startsWith("error:")) ??
    lines[lines.length - 1] ??
    ""
  );
}

/** Compact relative-time label for a recent repo's last-open time. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return "";
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return "yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  if (diff < 30 * day) {
    const weeks = Math.floor(diff / (7 * day));
    return weeks <= 1 ? "last week" : `${weeks} weeks ago`;
  }
  if (diff < 365 * day) {
    const months = Math.floor(diff / (30 * day));
    return months <= 1 ? "last month" : `${months} months ago`;
  }
  const years = Math.floor(diff / (365 * day));
  return years <= 1 ? "last year" : `${years} years ago`;
}

/** Up-to-two-letter initials + a stable hue (0–359) derived from a repo name,
 * for the recent-list avatar. */
export function avatarFor(name: string): { initials: string; hue: number } {
  const words = name.replace(/[^a-z0-9]/gi, " ").trim().split(/\s+/).filter(Boolean);
  // Two words → one letter each ("gitlane-core" → "GC"); one word → its first
  // two letters ("infra" → "IN"); nothing usable → "?".
  const raw =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : words.length === 1
        ? words[0].slice(0, 2)
        : name.slice(0, 2) || "?";
  const initials = raw.toUpperCase();
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return { initials, hue: hash % 360 };
}

/** Parent directory of a path (no trailing slash). "" when there's no parent. */
export function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (slash === 0) return "/";
  return "";
}

/** Join a parent directory and a leaf into a path (normalising the separator). */
export function joinPath(parent: string, leaf: string): string {
  if (!parent) return leaf;
  return `${parent.replace(/\/+$/, "")}/${leaf}`;
}

/** `.gitignore` starter templates offered on the init form. Values are sent to
 * the backend, which owns the actual file contents (see write/lifecycle.rs). */
export const GITIGNORE_TEMPLATES = ["None", "Node", "Rust", "Python", "macOS"] as const;
export type GitignoreTemplate = (typeof GITIGNORE_TEMPLATES)[number];

/** The parts of a recents entry that decide which repository it belongs to. */
export interface RecentIdentity {
  path: string;
  mainPath?: string | null;
}

/** The repository identity of a recents entry: its main checkout's path when
 * the entry is a linked worktree, else its own path. The same rule as
 * `lib/tabs.ts`'s `tabIdentity`, which is what custom names and groups are
 * keyed by — without it a worktree row shows the folder name and sections as
 * Ungrouped while its tab shows the repository's name and group. */
export function recentIdentity(repo: RecentIdentity): string {
  return trimTrailingSlash(repo.mainPath || repo.path);
}

/** The recent-repositories list split into its group sections: one per group
 * that has an entry, in the groups' own order, with the ungrouped remainder
 * last. Recency order is preserved inside each section.
 *
 * Sectioned by the entry's *repository identity* (`recentIdentity`), so a
 * linked-worktree row lands in the same group as the repository it belongs to
 * rather than in Ungrouped.
 */
export function recentSections<G extends { id: string }, R extends RecentIdentity>(
  recents: R[],
  groups: G[],
  groupIdOf: (identity: string) => string | null,
): { group: G | null; repos: R[] }[] {
  const byGroup = new Map<string, R[]>();
  const ungrouped: R[] = [];
  for (const repo of recents) {
    const groupId = groupIdOf(recentIdentity(repo));
    if (groupId === null) {
      ungrouped.push(repo);
      continue;
    }
    const bucket = byGroup.get(groupId);
    if (bucket) bucket.push(repo);
    else byGroup.set(groupId, [repo]);
  }
  const sections: { group: G | null; repos: R[] }[] = groups
    .filter((g) => byGroup.has(g.id))
    .map((group) => ({ group, repos: byGroup.get(group.id) ?? [] }));
  if (ungrouped.length > 0) sections.push({ group: null, repos: ungrouped });
  return sections;
}
