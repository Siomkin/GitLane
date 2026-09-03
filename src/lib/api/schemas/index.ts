// Runtime schemas for every IPC response (GL-57). The `lib/api` wrappers parse
// each `invoke()` result through one of these (`validate.ts`'s `parse`) so a
// serde-struct/TS-interface drift surfaces as a clear IpcValidationError at the
// seam instead of an undefined-access crash inside a component.
//
// The schema is the runtime source of truth; the hand-written, documented
// interface (under `git/types/`, `github/types.ts`, `providers.ts`,
// `terminal.ts`, `updater.ts`) stays the *type* source of truth so its rich
// field docs survive. The `assertEqual` guards at the end of every module fail
// the build if the two ever diverge — so a field added to one must be added to
// the other.
//
// Unknown fields are *stripped*, not rejected: these objects use Zod's default
// `.strip()` (no `.strict()`) deliberately. A newer backend that adds a field
// must not throw on an older frontend — forward-compat is preferred over
// fail-fast here. Drift that actually matters (a field a consumer relies on)
// still can't slip through: `assertEqual` fails the build when schema and
// interface diverge. The strip only silences backend-only additions the
// frontend doesn't read yet, which is the safe direction to be lenient in.
//
// One module per domain, mirroring `git/types/` (plus `github`, `providers`,
// `terminal`, `updater` for the flat wrapper modules). `git/types/auth.ts` has
// no schema module: its shapes (`GitTransportAuthRef`, `RemoteAccountRef`) are
// request arguments, never responses. Event payload schemas live in `events.ts`.

export * from "./conflicts";
export * from "./diff";
export * from "./files";
export * from "./github";
export * from "./graph";
export * from "./preview";
export * from "./providers";
export * from "./refs";
export * from "./repo";
export * from "./status";
export * from "./terminal";
export * from "./updater";
export * from "./worktree";
