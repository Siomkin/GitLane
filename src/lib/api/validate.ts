import type { ZodType } from "zod";

// The seam's two boundary-level failures: a *rejection* is always a
// `CommandError` (kind/code classified in Rust, converted in `invoke.ts` —
// `isCommandError` narrows it), and a *malformed success* payload is an
// `IpcValidationError` thrown by `parse` below.
export { isCommandError } from "./invoke";

/** Thrown when an `invoke()` result fails its schema at the `lib/api` seam — the
 * IPC contract (Rust serde struct ↔ TS interface) drifted, or the backend sent
 * an unexpected shape. Surfacing this *here*, named, with the command and the
 * offending fields, turns what used to be an `undefined`-access crash deep in a
 * component into a clear, boundary-level failure (caught by the feature error
 * boundaries from GL-56) instead. */
export class IpcValidationError extends Error {
  constructor(
    readonly command: string,
    readonly issues: string,
  ) {
    super(`Malformed response from "${command}": ${issues}`);
    this.name = "IpcValidationError";
  }
}

/** Validate an `invoke()` result against its schema, returning the typed value
 * or throwing {@link IpcValidationError} with a single-line summary of the bad
 * fields. The schema is the source of runtime truth; the matching hand-written
 * interface is held to it by a compile-time guard in `schemas.ts`. */
export function parse<T>(schema: ZodType<T>, value: unknown, command: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new IpcValidationError(command, issues);
}
