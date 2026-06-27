// Pure, framework-free helpers for the repository onboarding flow (GL-38): Git
// URL validation, clone-error classification into actionable copy, recent-repo
// presentation (relative time + avatar), and path math. No React, no IPC — all
// of this is unit-tested in onboarding.test.ts.

/** The seven onboarding screens (mirrors the RepoOnboarding mockup's `screen`). */
export type OnboardingScreen =
  | "home"
  | "clone"
  | "progress"
  | "error"
  | "init"
  | "empty"
  | "opened";

export type UrlState = "empty" | "valid" | "invalid";

/** Validate a clone URL and extract the repo name it would produce. Accepts
 * https(s)://, git@host:path, ssh://, and git:// forms — matching what `git
 * clone` understands. */
export function validateCloneUrl(raw: string): { state: UrlState; repo: string } {
  const url = (raw ?? "").trim();
  if (!url) return { state: "empty", repo: "repository" };
  const wellFormed =
    /^(https?:\/\/|git@[\w.-]+:|ssh:\/\/|git:\/\/)[^\s]+/.test(url) &&
    /[/:][\w.-]+(\.git)?\/?$/.test(url);
  return { state: wellFormed ? "valid" : "invalid", repo: parseRepoName(url) };
}

/** The repository (leaf) name a clone URL resolves to, sans `.git`. Falls back
 * to "repository" when nothing parseable is present. */
export function parseRepoName(url: string): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  const match = trimmed.match(/([\w.-]+?)(\.git)?$/);
  return match && match[1] ? match[1] : "repository";
}

export type CloneErrorKind = "exists" | "auth" | "unreachable" | "canceled" | "failed";

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
}

/** Map a git clone failure (raw stderr) to actionable copy + a kind the UI uses
 * to decide whether retry re-runs the clone or returns to the form. */
export function classifyCloneError(raw: string): CloneErrorCopy {
  const message = (raw ?? "").trim();
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
    };
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("invalid username or password") ||
    lower.includes("permission denied") ||
    lower.includes("terminal prompts disabled")
  ) {
    return {
      kind: "auth",
      title: "Authentication failed",
      message:
        "GitLane couldn't authenticate with the remote. Check your saved credentials or SSH key, then try again.",
      cmd,
      fail: true,
      retryLabel: "Retry",
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
    return {
      kind: "unreachable",
      title: "Couldn't reach that repository",
      message:
        "The remote URL looks wrong or the host can't be reached. Double-check the address and your network connection.",
      cmd,
      fail: true,
      retryLabel: "Edit URL",
    };
  }
  return {
    kind: "failed",
    title: "Clone failed",
    message: message || "The clone didn't finish. Check the URL and try again.",
    cmd,
    fail: true,
    retryLabel: "Try again",
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
  };
}

/** Whether an error of `kind` should re-run the clone on retry (auth/canceled/
 * generic) vs. return to the form so the user can fix the URL/destination. */
export function retryRerunsClone(kind: CloneErrorKind): boolean {
  return kind === "auth" || kind === "canceled" || kind === "failed";
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
