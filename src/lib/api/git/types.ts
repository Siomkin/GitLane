// Every serde struct the Rust side returns across IPC, plus the const enums
// whose values the backend emits. Mirrors `src-tauri/src/git/types/` — keep the
// field names in sync; the Rust structs are all `rename_all = "camelCase"`.
//
// The declarations live in focused modules under `types/`, one per Rust domain
// module, and are re-exported flat from here (GL-341) — so every consumer keeps
// importing from `@/lib/api` / `@/lib/api/git` regardless of which module owns
// a name. (`forge.rs` has no module here: its TS counterparts live in
// `lib/api/github.ts`.)

export * from "./types/auth";
export * from "./types/conflicts";
export * from "./types/diff";
export * from "./types/error";
export * from "./types/files";
export * from "./types/graph";
export * from "./types/preview";
export * from "./types/refs";
export * from "./types/repo";
export * from "./types/requests";
export * from "./types/status";
export * from "./types/worktree";
