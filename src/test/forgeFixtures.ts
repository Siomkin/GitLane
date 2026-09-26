// Test-side mirror of the pull-request capabilities each Rust adapter declares
// (`identity().capabilities` in `src-tauri/src/git/forge/*`). A fixture that
// puts a forge in the repo store takes its record from here, so the PR gates see
// what `repo_forge` would send. The Rust dispatch test
// (`every_absent_capability_is_a_refusing_adapter_method`) pins the source.

import { ForgeKind, type ForgeCapabilities } from "@/lib/api";

const ALL_STATE_ACTIONS: ForgeCapabilities["stateActions"] = ["close", "reopen", "ready"];

const FORGE_CAPABILITIES: Partial<Record<ForgeKind, ForgeCapabilities>> = {
  [ForgeKind.GitHub]: {
    create: true,
    mergeMethods: ["merge", "squash", "rebase"],
    stateActions: ALL_STATE_ACTIONS,
    deleteBranch: true,
    stacks: true,
  },
  [ForgeKind.GitLab]: { create: true, mergeMethods: ["merge", "squash"], stateActions: [], deleteBranch: true, stacks: false },
  [ForgeKind.Bitbucket]: { create: true, mergeMethods: ["merge", "squash"], stateActions: [], deleteBranch: true, stacks: false },
  [ForgeKind.CursorOrigin]: {
    create: true,
    mergeMethods: ["merge", "squash"],
    stateActions: ALL_STATE_ACTIONS,
    deleteBranch: false,
    stacks: false,
  },
};

/** The capabilities the backend declares for `kind`; null for a forge without
 * pull requests in GitLane (or no forge). */
export const capabilitiesFor = (kind: ForgeKind | null | undefined): ForgeCapabilities | null =>
  (kind != null ? FORGE_CAPABILITIES[kind] : undefined) ?? null;
