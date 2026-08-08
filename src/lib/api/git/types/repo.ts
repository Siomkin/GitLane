// Repository identity, lifecycle, forge summary, and remotes — mirrors
// `src-tauri/src/git/types/repo.rs`.

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

/** The classified rejection of `open_repo` — the one structured IPC error
 * (everything else rejects with a string). Rust distinguishes a moved/deleted
 * path (`missing`) and a folder that lost its `.git` (`notARepository`) from
 * real failures (`other`) so the store can swap in the dedicated missing-repo
 * state instead of the raw libgit2 message (GL-108). */
export interface RepoOpenError {
  kind: "missing" | "notARepository" | "other";
  /** Human-readable message (used for the error bar on `other`). */
  message: string;
  /** The path the open was attempted with. */
  path: string;
}

/** Narrow an `api.openRepo` rejection to the structured {@link RepoOpenError}. */
export function isRepoOpenError(e: unknown): e is RepoOpenError {
  if (!e || typeof e !== "object") return false;
  const err = e as Partial<RepoOpenError>;
  return (
    (err.kind === "missing" || err.kind === "notARepository" || err.kind === "other") &&
    typeof err.message === "string" &&
    typeof err.path === "string"
  );
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
} as const;
export type ForgeKind = (typeof ForgeKind)[keyof typeof ForgeKind];

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
