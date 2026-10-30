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

export const remoteHostSchema = z.object({
  origin: z.string(),
  home: z.string().nullable(),
  git: z.string().nullable(),
});
assertEqual<z.infer<typeof remoteHostSchema>, RemoteHost>(true);

export const remoteApi = {
  /** Connect to `locator`'s host now, installing GitLane's agent there first
   * if needed (progress arrives as `remote-session-changed`). */
  remoteConnect: async (locator: string) =>
    parse(remoteHostSchema, await invoke("remote_connect", { locator }), "remote_connect"),

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
