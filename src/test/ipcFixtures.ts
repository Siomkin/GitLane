// Schema-valid "empty" IPC payloads for tests that mock `invoke` (GL-57 seam
// validation). Every `lib/api` wrapper now parses its result, so a store test's
// catch-all `default: return Promise.resolve([])` — which used to stand in for
// any read — is rejected for anything that is not a list, and `undefined`
// is rejected for the status string every write resolves with.
//
// `emptyIpcPayload(cmd)` answers the shape each command's schema accepts with
// nothing in it: `[]` for list reads, an idle/no-remote object for the object
// reads a refresh performs, `null` for the nullable lookups, `undefined` for
// the void commands, and `""` — an empty status message — for every write.
// Tests still queue their own results for the commands under test; this is the
// fallback for the reads and writes they do not care about.

import type {
  OperationStatus,
  RepoForge,
  RepoGraph,
  WorkingChanges,
} from "@/lib/api";
import { emptyAdvancedState } from "@/lib/advancedRepoState";

export const EMPTY_GRAPH: RepoGraph = {
  commits: [],
  edges: [],
  laneCount: 1,
  wipLane: null,
  head: null,
  truncated: false,
};

export const EMPTY_CHANGES: WorkingChanges = {
  staged: [],
  unstaged: [],
  conflicted: [],
  advanced: emptyAdvancedState,
};

export const IDLE_OPERATION: OperationStatus = {
  kind: "none",
  canSkip: false,
  conflicts: [],
  advisory: "",
};

export const NO_FORGE: RepoForge = {
  hasRemote: false,
  kind: null,
  forge: null,
  host: null,
  webUrl: null,
};

const LIST_READS = new Set([
  "acp_adapters",
  "acp_agents_get",
  "acp_agents_reset",
  "ancestor_refs",
  "commit_files",
  "diff_range",
  "forge_auth_statuses",
  "github_accounts",
  "list_branches",
  "list_pull_requests",
  "list_reflog",
  "list_remotes",
  "list_signing_keys",
  "list_stashes",
  "list_worktrees",
  "pull_request_checks",
  "pull_request_diff",
  "pull_request_reviewer_candidates",
  "range_commits",
  "recents_status",
  "repository_stacks",
  "selection_diff",
  "suggest_tree_paths",
  "terminal_agents_get",
  "terminal_agents_reset",
]);

const NULLABLE_READS = new Set([
  "check_update_on_channel",
  "default_base_branch",
  "default_git_identity",
  "forge_account",
  "pull_request_stack",
  "repo_file_head_text",
  "repo_identity",
]);

const BOOLEAN_READS = new Set([
  "acp_cancel",
  "can_fast_forward",
  "commit_path_is_restorable",
  "terminal_agent_probe",
  "worktree_differs_from_commit",
  "worktree_is_dirty",
]);

const VOID_COMMANDS = new Set([
  "acp_agents_set",
  "cancel_clone",
  "cancel_github_sign_in",
  "cancel_provider_oauth_sign_in",
  "commit_agent_messages_set",
  "delete_provider_token",
  "github_sign_out",
  "pty_kill",
  "pty_resize",
  "pty_write",
  "refresh_tool_probes",
  "remove_index_lock",
  "reveal_path",
  "set_oauth_client_id",
  "terminal_agents_set",
  "unwatch_repo",
  "watch_repo",
]);

/** The emptiest payload `cmd`'s schema accepts. Object reads with no natural
 * empty value (`open_repo`, the previews, the diffs, …) are not covered — a
 * test that reaches them must supply a fixture. */
export function emptyIpcPayload(cmd: string): unknown {
  if (LIST_READS.has(cmd)) return [];
  if (NULLABLE_READS.has(cmd)) return null;
  if (BOOLEAN_READS.has(cmd)) return false;
  if (VOID_COMMANDS.has(cmd)) return undefined;
  switch (cmd) {
    case "commit_graph":
      return EMPTY_GRAPH;
    case "working_changes":
      return EMPTY_CHANGES;
    case "operation_status":
      return IDLE_OPERATION;
    case "repo_forge":
      return NO_FORGE;
    case "search_history":
      return { results: [], truncated: false, workTruncated: false };
    case "approve_https_credential":
      return { username: "", helper: "" };
    case "reject_https_credential":
      return { helper: "" };
    case "save_provider_token":
    case "provider_token_status":
      // The keychain echoes the locator back; "stored" is the only shape a
      // test that ignores this call can proceed on.
      return {
        provider: "",
        host: "",
        accountId: "",
        login: "",
        hasToken: true,
      };
    default:
      // Every write resolves with a human status string.
      return "";
  }
}

/** `emptyIpcPayload` as a resolved promise — the shape `invokeMock`'s
 * `mockImplementation` fallback wants. */
export const emptyIpcInvoke = (cmd: string): Promise<unknown> =>
  Promise.resolve(emptyIpcPayload(cmd));
