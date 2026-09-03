// Repository identity, lifecycle, forge summary, and remotes — mirrors
// `src-tauri/src/git/types/repo.rs`.

import { isCommandError, type CommandError } from "@/lib/api/invoke";

export interface RepoSummary {
  path: string;
  workdir: string | null;
  headBranch: string | null;
  headOid: string | null;
  detached: boolean;
  /** True when HEAD is unborn (fresh `git init`, no commits yet) — the UI
   * shows "No commits yet" instead of "No branch". Optional for
   * backward-compatible fixtures; the backend always sends it. */
  unborn?: boolean;
  /** True when this checkout is a *linked* worktree. Optional for
   * backward-compatible fixtures; the backend always sends it. */
  isWorktree?: boolean;
  /** The main checkout's path for a linked worktree — the stable repository
   * identity (GL-109/GL-110); null for the main checkout itself. Optional for
   * fixtures; the backend always sends it. */
  mainPath?: string | null;
}

/** The one four-state reality the summary's head fields encode — a frontend
 * derivation, not a wire change: the raw fields stay on {@link RepoSummary}.
 * The backend guarantees the correlations (`head_branch` is null when
 * detached; an unborn HEAD's name is resolved from HEAD's symbolic target),
 * but each consumer used to re-derive the same `detached`/`unborn`/
 * `headBranch` ladder by hand — derive it once here and switch on `kind`.
 * `detached` wins even if a fixture somehow also sets `headBranch` (the wire
 * type permits it; the backend never does). */
export type HeadState =
  | { kind: "detached"; oid: string }
  | { kind: "unborn"; branch: string }
  | { kind: "branch"; branch: string; oid: string }
  | { kind: "none" };

/** Classify a summary's HEAD into the {@link HeadState} reality. Null-safe:
 * no repo is `none`, just like a summary whose head resolves to nothing.
 * Nullable raw fields are normalized to `""` (the backend always populates
 * them for the state that reads them). */
export function headStateOf(summary: RepoSummary | null): HeadState {
  if (!summary) return { kind: "none" };
  if (summary.detached) return { kind: "detached", oid: summary.headOid ?? "" };
  if (summary.unborn) return { kind: "unborn", branch: summary.headBranch ?? "" };
  if (summary.headBranch) {
    return { kind: "branch", branch: summary.headBranch, oid: summary.headOid ?? "" };
  }
  return { kind: "none" };
}

/** The `open_repo` rejections that mean the *path* is the problem, not the
 * read: a moved/deleted folder (`missingPath`) or one that lost its `.git`
 * (`notARepository`). The store swaps in the dedicated missing-repo state for
 * these instead of the raw libgit2 message (GL-108); every other kind keeps
 * the error-bar behavior. `path` is always populated for these kinds. */
export type RepoOpenError = CommandError & { kind: "missingPath" | "notARepository" };

/** Narrow an `api.openRepo` rejection to a {@link RepoOpenError}. */
export function isRepoOpenError(e: unknown): e is RepoOpenError {
  return isCommandError(e) && (e.kind === "missingPath" || e.kind === "notARepository");
}

/** Commit identity pinned for a repo: name + email, plus optional signing
 * config. Only the signing *reference* (GPG key id or SSH key path/literal) is
 * ever carried here — never a passphrase or private key. */
export interface RepoIdentity {
  name: string;
  email: string;
  /** `user.signingkey` pinned locally, if any. */
  signingKey?: string;
  /** `gpg.format` — "openpgp" or "ssh". */
  gpgFormat?: string;
  /** `commit.gpgsign` pinned locally, if any. */
  gpgSign?: boolean;
  /** `tag.gpgsign` pinned locally, if any. */
  tagGpgSign?: boolean;
}

/** The repo-identity snapshot a commit-creating write was composed against —
 * the tagged payload replacing the former `identity` + `identityCaptured` pair,
 * so "did not read one" and "read it; the repo had none" stay distinct. Build
 * it with `capturedIdentityArg` — the one place the distinction is decided. */
export type CapturedIdentity =
  | { mode: "notCaptured" }
  | { mode: "capturedNone" }
  | { mode: "card"; identity: RepoIdentity };

/** Optional signing config for {@link api.setRepoIdentity}. Tri-state per field
 * on the Rust side: omitted/`undefined` leaves the local key untouched, an
 * empty string unsets it, a value writes it. */
export interface RepoSigningConfig {
  signingKey?: string;
  gpgFormat?: string;
  gpgSign?: boolean;
  tagGpgSign?: boolean;
}

/** A signing key the user already has, for the profile editor's key picker.
 * Reference only — a full GPG fingerprint or SSH public-key path, never private
 * material. */
export interface SigningKey {
  /** Written to `user.signingkey` — a full GPG fingerprint or SSH public-key
   * path. */
  value: string;
  /** GPG uid, or SSH key type + comment. */
  label: string;
  format: "openpgp" | "ssh";
}

/** Presence + current branch of a previously-opened repo path (see Rust
 * `RecentStatus`). `exists: false` marks a path that no longer resolves on disk
 * so the onboarding list can flag it "Missing" (and session restore can drop
 * the tab). The tab strip shares this probe for worktree-tab labeling. */
export interface RecentStatus {
  path: string;
  exists: boolean;
  branch: string | null;
  /** True when the path is a *linked* worktree of some repository. Optional
   * for fixtures; the backend always sends it. */
  isWorktree?: boolean;
  /** The main checkout's path when `isWorktree` (see RepoSummary.mainPath).
   * Optional for fixtures; the backend always sends it. */
  mainPath?: string | null;
}

/** Payload of the `clone-progress` event streamed during a clone (see Rust
 * `CloneProgress`). `pct` is the blended overall completion 0–100. */
export interface CloneProgress {
  stage: string;
  pct: number;
}

/** Remote forge keys emitted by the backend's `ForgeKind::key()`
 * (`src-tauri/src/git/forge.rs`). This is the single source of truth on the TS
 * side — compare against `ForgeKind.GitHub` rather than a bare `"github"`
 * literal, so a typo fails to compile and a rename is one edit. Keep in sync
 * with the Rust enum across the IPC boundary. */
export const ForgeKind = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
  AzureDevOps: "azure-devops",
  Gitea: "gitea",
  Forgejo: "forgejo",
  CursorOrigin: "cursor-origin",
} as const;
export type ForgeKind = (typeof ForgeKind)[keyof typeof ForgeKind];

/** Canonical Cursor Origin git host — keep in sync with Rust
 * `ForgeKind::CURSOR_ORIGIN_HOST`. */
export const CURSOR_ORIGIN_HOST = "origin.cursor.com";

/** Browser root for Cursor Origin PRs — keep in sync with Rust
 * `ForgeKind::CURSOR_ORIGIN_WEB_ROOT`. Distinct from the git host. */
export const CURSOR_ORIGIN_WEB_ROOT = "https://cursor.com/codebase";

/** Remote-forge summary driving the toolbar provider indicator. */
export interface RepoForge {
  /** True when the repo has at least one remote with a URL. */
  hasRemote: boolean;
  /** Forge key (see {@link ForgeKind}), or null when the host is unrecognised. */
  kind: ForgeKind | null;
  /** Human forge label ("GitHub", "GitLab", …), or null when unrecognised. */
  forge: string | null;
  /** Remote host (e.g. "github.com"), or null when no remote is configured. */
  host: string | null;
  /** Browser URL for the repo (`https://host/owner/repo`), or null when none. */
  webUrl: string | null;
}

/** A configured git remote (Repository settings → Remotes). */
export interface RemoteInfo {
  /** Remote name (e.g. "origin"). */
  name: string;
  /** Fetch URL. */
  fetchUrl: string;
  /** Push URL — equals the fetch URL unless a separate push URL is set. */
  pushUrl: string;
  /** True for the repo's default push remote. */
  isDefault: boolean;
}
