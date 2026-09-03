// The backend → webview event contract: every event name, declared once.
//
// An event name is just a string on both sides of IPC, so a rename on one side
// compiles and passes every test while the listener silently goes quiet at
// runtime. The names live here and in `src-tauri/src/events.rs`, and the parity
// test in that module's `mod tests` asserts the two sets are equal — the same
// technique that guards the command registry.
//
// ---- PARSE CONTRACT (read before editing) ----
// The Rust parity test reads this file as text and recognises an event name by
// exactly this one-line form:
//
//     export const SCREAMING_SNAKE_NAME = "the-event-name";
//
// an ALL-CAPS (`A-Z`, `0-9`, `_`) identifier, `= `, a double-quoted string, a
// semicolon — all on one line. Declare every event that way: no `as const`, no
// template literal, no wrapping object, no line break. Anything else this file
// exports (payload types, schemas, `listenTyped`) is invisible to that parser
// because its identifier is not ALL-CAPS, so it can be written freely.
//
// ---- Payloads ----
// The event-only DTOs live here beside their names, with a zod schema each and
// an `assertEqual` guard holding schema and interface together. Two payload
// types stay in their domain modules, mirroring the Rust side, because they are
// also those modules' own types: `CloneProgress` (`git/types/repo.ts` ↔
// `git/write/lifecycle.rs`) and `ProviderOauthProgress` (`providers.ts` ↔
// `git/oauth/types.rs`). Everything is camelCase on the wire.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import type { CloneProgress } from "./git";
import type { ProviderOauthProgress } from "./providers";
import { parse } from "./validate";

/** A repository's worktree or git state changed on disk (filesystem watcher). */
export const REPO_CHANGED = "repo-changed";
/** A PTY session produced output. */
export const PTY_DATA = "pty-data";
/** A PTY session's shell exited. */
export const PTY_EXIT = "pty-exit";
/** A clone advanced to the next phase / percentage. */
export const CLONE_PROGRESS = "clone-progress";
/** An ACP agent turn reported what it is doing. */
export const ACP_PROGRESS = "acp-progress";
/** A branch hand-off between worktrees advanced a step. */
export const HANDOFF_PROGRESS = "handoff-progress";
/** A branch+worktree delete advanced a step. */
export const DELETE_WORKTREE_PROGRESS = "delete-worktree-progress";
/** An in-app `gh auth login` advanced a step. */
export const GITHUB_SIGNIN_PROGRESS = "github-signin-progress";
/** A native provider OAuth sign-in advanced a step. */
export const PROVIDER_OAUTH_PROGRESS = "provider-oauth-progress";

// ---- payload types ----

/** Which half of the repo a filesystem event touched — worktree/index churn, or
 *  something that moves refs and therefore the graph. */
export type RepoChangeKind = "worktree" | "graph";

/** {@link REPO_CHANGED} payload. */
export interface RepoChangedEvent {
  kind: RepoChangeKind;
  /** The open path whose watch fired (`summary.path`) — with one watcher per
   * open tab, events must be routed to the tab they belong to. */
  path: string;
}

/** {@link PTY_DATA} payload: raw bytes read from the session's master side. */
export interface PtyDataEvent {
  sessionId: number;
  data: number[];
}

/** {@link PTY_EXIT} payload: the session whose shell exited. */
export interface PtyExitEvent {
  sessionId: number;
}

/** {@link ACP_PROGRESS} payload: the latest tool-call title of one agent turn,
 *  tagged with the run it belongs to so two banners never cross-talk. */
export interface AcpProgress {
  runId: string;
  message: string;
}

/** {@link HANDOFF_PROGRESS} payload — one per phase as it begins. */
export interface HandoffProgressEvent {
  step: string;
}

/** {@link DELETE_WORKTREE_PROGRESS} payload — one per phase as it begins. */
export interface DeleteWorktreeProgressEvent {
  step: string;
}

/** {@link GITHUB_SIGNIN_PROGRESS} payload (Rust `SignInProgress`). `code`/`url`
 *  are present only on the initial `"code"` step. */
export interface SignInProgress {
  /** `"code"` | `"browser"` | `"authorized"`. */
  step: string;
  code?: string;
  url?: string;
}

// ---- schemas ----
//
// Unknown fields are stripped, not rejected — the same forward-compat stance
// `schemas.ts` documents for command responses: a newer backend adding a field
// must not break an older webview.

export const repoChangedEventSchema = z.object({
  kind: z.enum(["worktree", "graph"]),
  path: z.string(),
});

// `data` is a 4 KiB-per-tick byte array on the terminal's hot render path, so it
// is checked for shape rather than element-by-element: `z.array(z.number())`
// would validate every byte of every chunk a `cat` produces. The drift this
// guard exists to catch — a renamed, missing, or differently-typed field — is
// still caught; only per-byte checking is traded away.
export const ptyDataEventSchema = z.object({
  sessionId: z.number(),
  data: z.custom<number[]>(Array.isArray, { message: "expected an array of bytes" }),
});

export const ptyExitEventSchema = z.object({
  sessionId: z.number(),
});

export const cloneProgressSchema = z.object({
  stage: z.string(),
  pct: z.number(),
});

export const acpProgressSchema = z.object({
  runId: z.string(),
  message: z.string(),
});

export const handoffProgressEventSchema = z.object({
  step: z.string(),
});

export const deleteWorktreeProgressEventSchema = z.object({
  step: z.string(),
});

export const signInProgressSchema = z.object({
  step: z.string(),
  code: z.string().optional(),
  url: z.string().optional(),
});

export const providerOauthProgressSchema = z.object({
  provider: z.string(),
  step: z.string(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  expiresInSecs: z.number().optional(),
});

// ---- compile-time guards: schema output ≡ documented interface ----
// The twin of the `assertEqual` block at the bottom of `schemas.ts`, kept local
// so the event contract is readable in one file (and so splitting `schemas.ts`
// per domain doesn't have to move it). Only typechecks when the two types are
// identical, so a field added to one and not the other fails `tsc` here.

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

function assertEqual<_A, _B>(_proof: Equals<_A, _B> extends true ? true : never): void {}

assertEqual<z.infer<typeof repoChangedEventSchema>, RepoChangedEvent>(true);
assertEqual<z.infer<typeof ptyDataEventSchema>, PtyDataEvent>(true);
assertEqual<z.infer<typeof ptyExitEventSchema>, PtyExitEvent>(true);
assertEqual<z.infer<typeof cloneProgressSchema>, CloneProgress>(true);
assertEqual<z.infer<typeof acpProgressSchema>, AcpProgress>(true);
assertEqual<z.infer<typeof handoffProgressEventSchema>, HandoffProgressEvent>(true);
assertEqual<z.infer<typeof deleteWorktreeProgressEventSchema>, DeleteWorktreeProgressEvent>(true);
assertEqual<z.infer<typeof signInProgressSchema>, SignInProgress>(true);
assertEqual<z.infer<typeof providerOauthProgressSchema>, ProviderOauthProgress>(true);

/**
 * Subscribe to a backend event, validating every payload before the handler
 * sees it. The typed counterpart of `@tauri-apps/api/event`'s `listen`, and the
 * only door the app uses: a raw `listen` would hand a component a payload the
 * compiler *claims* is `T` with nothing checking that it is.
 *
 * A payload that fails `schema` throws an `IpcValidationError` (naming the
 * event and the offending fields) from inside the event callback instead of
 * reaching the handler — so a drifted contract shows up as a named boundary
 * error and the UI that consumes it, a progress checklist say, simply does not
 * advance. Each `listen` registration is its own callback id on the Rust side,
 * so a throw here cannot starve another event's listener.
 *
 * Returns the unlisten fn exactly like `listen` does; the caller owns that
 * lifecycle (an effect cleanup, a run-scoped `finally`).
 */
export function listenTyped<T>(
  name: string,
  schema: z.ZodType<T>,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(name, (event) => {
    handler(parse(schema, event.payload, name));
  });
}
