// The one error shape every Tauri command rejects with — mirrors
// `src-tauri/src/git/types/error.rs` (`CommandError` / `CommandErrorKind`).
// Classification happens in Rust, next to the process that observed the
// failure; the frontend branches on `kind` / `code` and only *formats* copy
// (see `lib/gitError.ts`). The runtime class that wraps this payload is
// `CommandError` in `lib/api/invoke.ts`.

/** Closed set of failure categories the frontend may branch on. Keep in sync
 * with the Rust enum; an unknown kind degrades to `internal` at the seam. */
export const COMMAND_ERROR_KINDS = [
  /** The `git` CLI reported a failure that fits no more specific category. */
  "git",
  /** A repository hook refused the operation; `hook` names it when known. */
  "hookRejected",
  /** A credential was missing, refused, or lacks permission. */
  "auth",
  /** The remote could not be reached (DNS, connection, TLS, host key). */
  "network",
  /** A leased write found the repository changed since the preview. */
  "staleLease",
  /** `.git/index.lock` exists and blocks the index write. */
  "indexLock",
  /** The operation left (or found) the repository mid-conflict. */
  "conflict",
  /** The path exists but is not a git repository. */
  "notARepository",
  /** The path no longer exists on disk. */
  "missingPath",
  /** A forge provider (`gh`, `glab`, REST, `origin`) failed for a reason
   * other than auth/network. */
  "forge",
  /** Anything else — unexpected, bug, or unclassified internal failure. */
  "internal",
] as const;

export type CommandErrorKind = (typeof COMMAND_ERROR_KINDS)[number];

/** The serialised IPC rejection. Optional fields are omitted on the wire when
 * absent (serde `skip_serializing_if`). */
export interface CommandErrorPayload {
  kind: CommandErrorKind;
  /** Finer sub-category within `kind` — stable identifiers the frontend picks
   * copy by. Under `auth`: `credentialsMissing` | `sshPublickey` | `forbidden`
   * | `notFoundOrDenied` | `notAuthenticated` | `permissionDenied` |
   * `hostMismatch`. Under `network`: `unreachable` | `sshHostKey` |
   * `transport`. Under `forge`: `providerUnavailable` | `unsupportedVersion`
   * | `providerUnusable` | `unsupportedForge` | `repositoryNotFound` |
   * `rateLimited` | `invalidResponse` | `commandFailed` | `outputTooLarge` |
   * `captureFailed` | `responseTooLarge`. Under `internal`: `keychain`. */
  code?: string;
  /** Human-readable and already redacted. For `hookRejected` this is the
   * hook's own reason lines (task-runner noise removed), newline-joined; for
   * everything else the full redacted git/gh text, trimmed. */
  message: string;
  /** Full redacted output when `message` is a summary of it (hook rejections). */
  detail?: string;
  /** The hook that refused the operation (`pre-commit`, `commit-msg`, …). */
  hook?: string;
  /** The path the failure concerns, for `missingPath` / `notARepository`. */
  path?: string;
}
