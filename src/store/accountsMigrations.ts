// One-shot migration of legacy localStorage account bindings into git config
// (GL-129): pre-gitcredentials builds stored the per-remote account choice in
// localStorage (v2 repo-wide, interim v3 per-remote); since the rework the
// choice is git-native — the HTTPS remote URL's username. The migration writes
// the stored selection into each remote's URL exactly once (never overwriting
// a username git config already has), collapses a v3 map down to the v2 PR-API
// entry that is still persisted, and refreshes the remote list.
//
// Pure core, impure shell: `planRemoteUsernameMigration` derives what to do
// (unit-tested, no IPC/Zustand); `migrateStoredRemoteUsernames` executes the
// plan (IPC writes, binding persistence, remote-list re-read, error toast).

import { api, type RemoteInfo } from "@/lib/api";
import { detectRemoteUrl } from "@/lib/remotes";
import {
  isV3Binding,
  prEntryFromRemoteBinding,
  resolvePrAccount,
  resolveRemoteBinding,
  STORED_ACCOUNT,
  type BindableAccount,
  type StoredRepoAccountEntry,
} from "./accountBindings";
import { readBindings, writeBindings } from "./accountsStorage";
import { useRepo } from "./repo";
import { useUi } from "./ui";

export type RemoteUsernameWrite = { remote: string; username: string | null };

export type RemoteUsernameMigrationPlan = {
  /** URL usernames to write into git config (empty = nothing to write). */
  writes: RemoteUsernameWrite[];
  /** True when the stored entry is a v3 map that must collapse to `nextEntry`
   * once the writes (if any) have landed. */
  collapseV3: boolean;
  /** The v2 PR-API entry that replaces a collapsed v3 map (undefined = the
   * stored entry is deleted). Meaningless unless `collapseV3`. */
  nextEntry: StoredRepoAccountEntry | undefined;
};

/** Derive the migration for a stored binding against the live remote list, or
 * null when there is nothing to do: no entry, no remotes, a v3 map before the
 * account list has loaded, or a v3 map with an unresolved binding (waiting is
 * safer than guessing — a temporarily missing account must not silently
 * switch identity). A username git config already has is never overwritten —
 * git is the new source of truth once it says anything. */
export function planRemoteUsernameMigration(
  entry: StoredRepoAccountEntry | undefined,
  remotes: RemoteInfo[],
  accounts: BindableAccount[],
  defaultRemoteName: string | null,
): RemoteUsernameMigrationPlan | null {
  if (!entry || remotes.length === 0) return null;
  if (isV3Binding(entry) && accounts.length === 0) return null;

  const writes: RemoteUsernameWrite[] = [];
  const addWrite = (remote: RemoteInfo, username: string | null) => {
    const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
    if (!info.valid || info.ssh) return;
    const current = info.user?.toLowerCase() ?? null;
    const next = username?.toLowerCase() ?? null;
    if (current === next) return;
    if (current !== null) return; // git config already has the new source of truth; do not overwrite it.
    writes.push({ remote: remote.name, username });
  };

  if (isV3Binding(entry)) {
    for (const remote of remotes) {
      const resolved = resolveRemoteBinding(entry.remotes[remote.name], accounts);
      if (resolved.kind === STORED_ACCOUNT.Unresolved) return null;
      if (resolved.kind === STORED_ACCOUNT.Unset) continue;
      addWrite(remote, resolved.kind === STORED_ACCOUNT.Account ? resolved.account.login : null);
    }
    return {
      writes,
      collapseV3: true,
      nextEntry: defaultRemoteName
        ? prEntryFromRemoteBinding(entry.remotes[defaultRemoteName], accounts)
        : undefined,
    };
  }

  const defaultRemote = remotes.find((r) => r.name === defaultRemoteName);
  const resolved = resolvePrAccount(entry, accounts);
  if (defaultRemote && resolved.kind !== STORED_ACCOUNT.Unset) {
    addWrite(defaultRemote, resolved.kind === STORED_ACCOUNT.Account ? resolved.account.login : null);
  }
  return { writes, collapseV3: false, nextEntry: entry };
}

/** In-flight migration keys, so a re-entrant `syncRepoAccount` (remote-list
 * refresh, account reload) can't double-write the same usernames. */
const remoteAccountMigrations = new Set<string>();

export async function migrateStoredRemoteUsernames(
  repoPath: string,
  key: string,
  entry: StoredRepoAccountEntry | undefined,
  remotes: RemoteInfo[],
  accounts: BindableAccount[],
  defaultRemoteName: string | null,
) {
  const plan = planRemoteUsernameMigration(entry, remotes, accounts, defaultRemoteName);
  if (!plan) return;

  const collapseV3 = () => {
    if (!plan.collapseV3) return;
    const bindings = readBindings();
    if (plan.nextEntry) bindings[key] = plan.nextEntry;
    else delete bindings[key];
    writeBindings(bindings);
  };

  if (plan.writes.length === 0) {
    collapseV3();
    return;
  }

  const migrationKey = `${key}\0${plan.writes.map((w) => `${w.remote}:${w.username ?? ""}`).join("\0")}`;
  if (remoteAccountMigrations.has(migrationKey)) return;
  remoteAccountMigrations.add(migrationKey);
  try {
    await Promise.all(plan.writes.map((w) => api.setRemoteUsername(repoPath, w.remote, w.username)));
    // Collapse only after every write landed — a failed IPC keeps the v3 map so
    // the migration retries on the next sync instead of dropping the choice.
    collapseV3();
    await useRepo.getState().listRemotes();
  } catch (e) {
    useUi.getState().showToast(String(e), "error");
  } finally {
    remoteAccountMigrations.delete(migrationKey);
  }
}
