// The repo an account/remote mutation targets, captured once before the first
// await (GL-167). Shared by every slice that writes a remote.

import type { RemoteInfo } from "@/lib/api";
import { storeLinks } from "@/store/links";

/** The one accounts-store field a capture reads. Declared here (not imported
 * from the facade) so a slice states the coupling in its own `get` type. */
export interface RepoBindingKeyRead {
  repoBindingKey: string | null;
}

/** The repo a remote-auth mutation targets, captured once before the first
 * await (GL-167). All IPC uses `path` so a mid-operation repo switch can't
 * retarget the write; the app-side binding persists under `bindingKey` (the
 * modified repo's key, never the then-current repo's); refreshes and success
 * toasts check `isCurrent()` so a newly-opened repo never receives another
 * repo's side effects. Error toasts stay unconditional — a failed write must
 * surface even after a switch. */
export interface RepoMutationTarget {
  path: string;
  bindingKey: string | null;
  remote: RemoteInfo | null;
  isCurrent: () => boolean;
}

export function captureRepoMutationTarget(
  repoBindingKey: string | null,
  remoteName?: string,
): RepoMutationTarget {
  const path = storeLinks.openRepo().summary?.path ?? "";
  const bindingKey = repoBindingKey ?? (path || null);
  const remote = remoteName
    ? (storeLinks.openRepo().remotes.find((r) => r.name === remoteName) ?? null)
    : null;
  return {
    path,
    bindingKey,
    remote,
    isCurrent: () => (storeLinks.openRepo().summary?.path ?? "") === path,
  };
}
