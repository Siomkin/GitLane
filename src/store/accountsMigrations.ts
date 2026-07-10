// One-shot migration of legacy localStorage account bindings into git config
// (GL-129): pre-gitcredentials builds stored the per-remote account choice in
// localStorage (v2 repo-wide, interim v3 per-remote); since the rework the
// choice is git-native — the HTTPS remote URL's username. This writes the
// stored selection into each remote's URL exactly once (never overwriting a
// username git config already has), collapses a v3 map down to the v2 PR-API
// entry that is still persisted, and refreshes the remote list.

import { api, type RemoteInfo } from "../lib/api";
import { detectRemoteUrl } from "../lib/remotes";
import {
  isV3Binding,
  prEntryFromRemoteBinding,
  resolvePrAccount,
  resolveRemoteBinding,
  type BindableAccount,
  type StoredRepoAccountEntry,
} from "./accountBindings";
import { readBindings, writeBindings } from "./accountsStorage";
import { useRepo } from "./repo";
import { useUi } from "./ui";

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
  if (!entry || remotes.length === 0) return;
  if (isV3Binding(entry) && accounts.length === 0) return;

  const writes: Array<{ remote: string; username: string | null }> = [];
  const addWrite = (remote: RemoteInfo, username: string | null) => {
    const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
    if (!info.valid || info.ssh) return;
    const current = info.user?.toLowerCase() ?? null;
    const next = username?.toLowerCase() ?? null;
    if (current === next) return;
    if (current !== null) return; // git config already has the new source of truth; do not overwrite it.
    writes.push({ remote: remote.name, username });
  };

  let nextEntry: StoredRepoAccountEntry | undefined = entry;
  if (isV3Binding(entry)) {
    for (const remote of remotes) {
      const resolved = resolveRemoteBinding(entry.remotes[remote.name], accounts);
      if (resolved === "unresolved") return;
      if (resolved === "unset") continue;
      addWrite(remote, resolved === "unbound" ? null : resolved.login);
    }
    nextEntry = defaultRemoteName
      ? prEntryFromRemoteBinding(entry.remotes[defaultRemoteName], accounts)
      : undefined;
  } else {
    const defaultRemote = remotes.find((r) => r.name === defaultRemoteName);
    const resolved = resolvePrAccount(entry, accounts);
    if (defaultRemote && resolved !== "unset") {
      addWrite(defaultRemote, resolved === "unbound" ? null : (resolved as BindableAccount).login);
    }
  }

  if (writes.length === 0) {
    if (isV3Binding(entry)) {
      const bindings = readBindings();
      if (nextEntry) bindings[key] = nextEntry;
      else delete bindings[key];
      writeBindings(bindings);
    }
    return;
  }

  const migrationKey = `${key}\0${writes.map((w) => `${w.remote}:${w.username ?? ""}`).join("\0")}`;
  if (remoteAccountMigrations.has(migrationKey)) return;
  remoteAccountMigrations.add(migrationKey);
  try {
    await Promise.all(writes.map((w) => api.setRemoteUsername(repoPath, w.remote, w.username)));
    if (isV3Binding(entry)) {
      const bindings = readBindings();
      if (nextEntry) bindings[key] = nextEntry;
      else delete bindings[key];
      writeBindings(bindings);
    }
    await useRepo.getState().listRemotes();
  } catch (e) {
    useUi.getState().showToast(String(e), "error");
  } finally {
    remoteAccountMigrations.delete(migrationKey);
  }
}
