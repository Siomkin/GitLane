// Repositories on another machine over SSH (remote-ssh-repos). Mirrors
// `commands/remote.rs`. `remote_invoke` has no wrapper here: `invoke()` routes
// every call whose path argument is an `ssh://` locator through it.

import { invoke } from "@/lib/api/invoke";
import { assertEqual } from "@/lib/api/schemas/assertEqual";
import { parse } from "@/lib/api/validate";
import { z } from "zod";

/** What connecting to a host learned (Rust `RemoteHost`). */
export interface RemoteHost {
  /** `ssh://[user@]host[:port]`. */
  origin: string;
  /** The connecting user's home directory on the host. */
  home: string | null;
  /** The host's `git --version`. */
  git: string | null;
}

/** A saved SSH connection (Rust `SshConnection`): one per
 * `ssh://[user@]host[:port]` origin. `identityFile` is a path, never a key. */
export interface SshConnection {
  name: string;
  /** An address, IP or `~/.ssh/config` alias. */
  host: string;
  user: string | null;
  port: number | null;
  identityFile: string | null;
}

export const sshConnectionSchema = z.object({
  name: z.string(),
  host: z.string(),
  user: z.string().nullable(),
  port: z.number().nullable(),
  identityFile: z.string().nullable(),
});
assertEqual<z.infer<typeof sshConnectionSchema>, SshConnection>(true);

export const remoteHostSchema = z.object({
  origin: z.string(),
  home: z.string().nullable(),
  git: z.string().nullable(),
});
assertEqual<z.infer<typeof remoteHostSchema>, RemoteHost>(true);

export const remoteApi = {
  /** Connect to `locator`'s host now, installing GitLane's agent there first
   * if needed (progress arrives as `remote-session-changed`). */
  remoteConnect: async (locator: string, identityFile: string | null = null) =>
    parse(remoteHostSchema, await invoke("remote_connect", { locator, identityFile }), "remote_connect"),

  /** The saved SSH connections, sorted by name. */
  listSshConnections: async () =>
    parse(z.array(sshConnectionSchema), await invoke("list_ssh_connections"), "list_ssh_connections"),

  /** Save `connection` (replacing `previousOrigin`'s when editing); the saved list. */
  saveSshConnection: async (previousOrigin: string | null, connection: SshConnection) =>
    parse(
      z.array(sshConnectionSchema),
      await invoke("save_ssh_connection", { previousOrigin, connection }),
      "save_ssh_connection",
    ),

  /** Remove the saved connection for `origin`; the saved list. */
  deleteSshConnection: async (origin: string) =>
    parse(z.array(sshConnectionSchema), await invoke("delete_ssh_connection", { origin }), "delete_ssh_connection"),

  /** End the session to `locator`'s host. */
  remoteDisconnect: (locator: string) => invoke<void>("remote_disconnect", { locator }),

  /** Answer `ssh`'s question `id`: the password, passphrase or code, `"yes"`
   * to trust a host key, or `null` to cancel. One of the three commands that
   * carry a secret; it goes only to the `ssh` that asked. */
  answerSshPrompt: (id: number, secretAnswer: string | null) =>
    invoke<void>("answer_ssh_prompt", { id, secretAnswer }),

  /** Concrete `Host` names from `~/.ssh/config`, to suggest in the open dialog. */
  listSshHosts: async () =>
    parse(z.array(z.string()), await invoke("list_ssh_hosts"), "list_ssh_hosts"),
};
