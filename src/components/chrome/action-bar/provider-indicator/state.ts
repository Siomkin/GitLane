import { ForgeKind } from "../../../../lib/api";
import type { RepoForge } from "../../../../lib/api";

/** Remote-provider indicator states (mirrors the design's `provider` tweak). */
export type ProviderState = "connected" | "needs-auth" | "unsupported" | "missing" | "error";

/** Auth signals the derivation reads from the accounts store. */
export interface ProviderAuthCtx {
  accounts: { host: string }[];
  accountsError: string | null;
  accountsLoading: boolean;
  repoAccountRef: { host: string } | null;
  /** Whether GitLab merge requests can be fetched for the repo — glab signed in
   * for the host or a stored provider token (GL-145). Ignored for other forges. */
  gitlabReady: boolean;
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
 * Auth is tracked for the two PR-capable forges: GitHub (`gh` accounts) and
 * GitLab (glab / stored token, GL-145) — each surfaces "needs-auth" when its
 * sign-in is missing. Other recognised forges (Bitbucket, Azure DevOps, Gitea,
 * Forgejo) are "connected" — their repo link works; they have no PR surface. */
export const deriveProviderState = (forge: RepoForge, ctx: ProviderAuthCtx): ProviderState => {
  if (!forge.hasRemote) return "missing";
  if (forge.kind === null) return "unsupported";
  // GitLab merge requests (GL-140): connected when glab / a token can serve
  // them, else needs-auth so the popover prompts a GitLab sign-in.
  if (forge.kind === ForgeKind.GitLab) return ctx.gitlabReady ? "connected" : "needs-auth";
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
