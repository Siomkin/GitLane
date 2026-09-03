// The IPC seam's error side: every `api.*` wrapper calls *this* `invoke`, which
// forwards to Tauri and converts any rejection into a `CommandError` — so the
// rest of the frontend can branch on `kind` / `code` without ever parsing
// git/gh text (`ipc/commands` spec). This is the only module that may import
// `invoke` from `@tauri-apps/api/core` (enforced in eslint.config.js).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  COMMAND_ERROR_KINDS,
  type CommandErrorKind,
  type CommandErrorPayload,
} from "./git/types/error";

/** A classified command failure. `toString()` returns the bare message (not
 * `"CommandError: …"`) so legacy `String(e)` call sites keep producing the
 * plain text — they just lose the `kind`, which is why sites that pick copy or
 * recovery actions must pass the error object itself. */
export class CommandError extends Error implements CommandErrorPayload {
  readonly kind: CommandErrorKind;
  readonly code?: string;
  readonly detail?: string;
  readonly hook?: string;
  readonly path?: string;

  constructor(payload: CommandErrorPayload) {
    super(payload.message);
    this.name = "CommandError";
    this.kind = payload.kind;
    this.code = payload.code;
    this.detail = payload.detail;
    this.hook = payload.hook;
    this.path = payload.path;
  }

  override toString(): string {
    return this.message;
  }
}

/** Narrow an unknown rejection to a {@link CommandError}. Tolerates a second
 * module instance (a test graph that loaded `lib/api` twice) by also accepting
 * an `Error` that carries the class's name and a string `kind`. */
export function isCommandError(e: unknown): e is CommandError {
  if (e instanceof CommandError) return true;
  return (
    e instanceof Error &&
    e.name === "CommandError" &&
    typeof (e as { kind?: unknown }).kind === "string"
  );
}

function isKnownKind(kind: unknown): kind is CommandErrorKind {
  return typeof kind === "string" && (COMMAND_ERROR_KINDS as readonly string[]).includes(kind);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The raw IPC payload, when `e` is one. A string `kind` outside the closed set
 * is *not* a payload — it becomes `internal` with the message preserved, per
 * the contract's "non-conforming rejections degrade to internal". */
function asPayload(e: unknown): CommandErrorPayload | null {
  if (!e || typeof e !== "object") return null;
  const raw = e as Record<string, unknown>;
  if (typeof raw.message !== "string") return null;
  if (!isKnownKind(raw.kind)) {
    return typeof raw.kind === "string" ? { kind: "internal", message: raw.message } : null;
  }
  return {
    kind: raw.kind,
    message: raw.message,
    code: optionalString(raw.code),
    detail: optionalString(raw.detail),
    hook: optionalString(raw.hook),
    path: optionalString(raw.path),
  };
}

/** Coerce any rejection into a {@link CommandError}: a `CommandError` passes
 * through, the raw IPC payload is wrapped, and an `Error`, a string, or
 * anything else becomes `kind: "internal"` with its text as the message. */
export function toCommandError(e: unknown): CommandError {
  if (isCommandError(e)) return e;
  const payload = asPayload(e);
  if (payload) return new CommandError(payload);
  if (e instanceof Error) return new CommandError({ kind: "internal", message: e.message });
  if (typeof e === "string") return new CommandError({ kind: "internal", message: e });
  return new CommandError({ kind: "internal", message: String(e) });
}

/** Call a Tauri command; a rejection is rethrown as a {@link CommandError}.
 * The `api.*` wrappers' response validation (`validate.ts`) runs *after* this
 * resolves, so an `IpcValidationError` is never wrapped.
 *
 * Deliberately not `async`: the returned promise is the transport's own with
 * one rejection handler attached, so it settles a single microtask after the
 * transport does (store tests count ticks around coalesced refreshes). `args`
 * is forwarded only when given, so a no-argument command reaches the transport
 * as a one-argument call. */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  let result: Promise<T>;
  try {
    result = Promise.resolve(
      args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args),
    );
  } catch (e) {
    return Promise.reject(toCommandError(e));
  }
  return result.then(undefined, (e: unknown) => {
    throw toCommandError(e);
  });
}
