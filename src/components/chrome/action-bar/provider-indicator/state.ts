import { ForgeKind } from "../../../../lib/api";
import type { RepoForge } from "../../../../lib/api";

/** Remote-provider indicator states (mirrors the design's `provider` tweak). */
export type ProviderState = "connected" | "needs-auth" | "unsupported" | "missing" | "error";

/** GitHub auth signals the derivation reads from the accounts store. */
export interface ProviderAuthCtx {
  accounts: { host: string }[];
  accountsError: string | null;
  accountsLoading: boolean;
  repoAccountRef: { host: string } | null;
}

/** Resolve the provider indicator's state — the *connection* status of the
 * repo's remote, surfaced as a link to the repo on its host. It is not about PR
 * support:
 *   - missing      no remote configured
 *   - unsupported  remote host GitLane doesn't recognise as a forge
 *   - connected    recognised forge, repo link ready (and, for GitHub, signed in)
 *   - needs-auth   GitHub remote with no usable `gh` account yet
 *   - error        GitHub remote whose account probe failed (e.g. `gh` missing)
 *
 * Auth is only checked for GitHub, the one forge whose sign-in state GitLane
 * tracks (via the accounts store). Other recognised forges (Bitbucket, GitLab,
 * Azure DevOps, Gitea, Forgejo) are "connected" — their repo link works; we just
 * don't probe their auth here. */
export const deriveProviderState = (forge: RepoForge, ctx: ProviderAuthCtx): ProviderState => {
  if (!forge.hasRemote) return "missing";
  if (forge.kind === null) return "unsupported";
  if (forge.kind !== ForgeKind.GitHub) return "connected";
  // GitHub — surface sign-in state via the accounts store.
  if (ctx.accountsError) return "error";
  // Stay optimistic while the account list is still loading, so the indicator
  // doesn't flash an amber "needs-auth" dot before the accounts arrive.
  if (ctx.accountsLoading && ctx.accounts.length === 0) return "connected";
  // Case-insensitive like the backend's normalize_host (and lib/prRemote), so
  // a mixed-case remote URL host doesn't read as "needs-auth".
  const host = (forge.host ?? "github.com").toLowerCase();
  const bound = ctx.repoAccountRef?.host.toLowerCase() === host;
  const hasAccount = ctx.accounts.some((a) => a.host.toLowerCase() === host);
  return bound || hasAccount ? "connected" : "needs-auth";
};
