import { ForgeKind } from "@/lib/api";
import type { RepoForge } from "@/lib/api";

/** Remote-provider indicator states (mirrors the design's `provider` tweak). */
export type ProviderState = "connected" | "transport-auth" | "needs-auth" | "unsupported" | "missing" | "error";

/** Auth signals the derivation reads from the accounts store. */
export interface ProviderAuthCtx {
  accounts: { host: string }[];
  accountsError: string | null;
  accountsLoading: boolean;
  repoAccountRef: { host: string } | null;
  /** Whether GitLab merge requests can be fetched for the repo — glab signed in
   * for the host or a stored provider token (GL-145). Ignored for other forges. */
  gitlabReady: boolean;
  /** Whether Bitbucket pull requests can be fetched for the repo — a stored
   * Bitbucket token exists for the host (GL-141). Ignored for other forges. */
  bitbucketReady: boolean;
  /** Whether Cursor Origin pull requests can be fetched — `origin` CLI signed
   * in. Ignored for other forges. */
  originReady: boolean;
  /** Whether the remote has a visible git transport auth signal: SSH or HTTPS
   * userinfo. Bare HTTPS helper/GCM credentials may exist, but the URL alone
   * cannot prove that they are configured. */
  transportConfigured: boolean;
  /** True once the non-GitHub forge CLI probe has settled (list or error).
   * False while it hasn't run yet — Settings used to be the only trigger, which
   * painted Origin/GitLab as needs-auth until that page opened. */
  forgeAuthSettled: boolean;
}

/** Resolve the provider indicator's state — the *connection* status of the
 * repo's remote, surfaced as a link to the repo on its host. It is not about PR
 * support:
 *   - missing      no remote configured
 *   - unsupported  remote host GitLane doesn't recognise as a forge
 *   - connected       recognised forge whose PR/MR API auth is ready
 *   - transport-auth  git fetch/push auth is configured, but PR/MR API auth is not
 *   - needs-auth      recognised forge with no known transport/API auth signal yet
 *   - error        GitHub remote whose account probe failed (e.g. `gh` missing)
 *
 * Auth is tracked for the PR-capable forges: GitHub (`gh` accounts),
 * GitLab (glab / stored token, GL-145), Bitbucket (stored token, GL-141), and
 * Cursor Origin (Origin CLI session). GCM/helper and SSH are transport auth
 * only, so they surface as "transport-auth" when PR API auth is missing. Other
 * recognised forges (Azure DevOps, Gitea, Forgejo) are "connected" — their repo
 * link works; they have no PR surface. */
export const deriveProviderState = (forge: RepoForge, ctx: ProviderAuthCtx): ProviderState => {
  if (!forge.hasRemote) return "missing";
  if (forge.kind === null) return "unsupported";
  // GitLab merge requests (GL-140): connected when glab / a token can serve
  // them, else distinguish transport-only GCM/SSH from no auth signal.
  if (forge.kind === ForgeKind.GitLab) {
    if (ctx.gitlabReady) return "connected";
    // Same GitHub accountsLoading guard: don't flash needs-auth before glab
    // status has been probed (that used to wait until Settings opened).
    if (!ctx.forgeAuthSettled) return "connected";
    return ctx.transportConfigured ? "transport-auth" : "needs-auth";
  }
  // Bitbucket pull requests (GL-141): connected when a stored token can serve
  // them, else distinguish transport-only GCM/SSH from no auth signal.
  if (forge.kind === ForgeKind.Bitbucket) {
    if (ctx.bitbucketReady) return "connected";
    return ctx.transportConfigured ? "transport-auth" : "needs-auth";
  }
  if (forge.kind === ForgeKind.CursorOrigin) {
    if (ctx.originReady) return "connected";
    if (!ctx.forgeAuthSettled) return "connected";
    return ctx.transportConfigured ? "transport-auth" : "needs-auth";
  }
  if (forge.kind !== ForgeKind.GitHub) return "connected";
  // GitHub — surface sign-in state via the accounts store.
  // Stay optimistic while the account list is still loading, so the indicator
  // doesn't flash an amber "needs-auth" dot before the accounts arrive.
  if (ctx.accountsLoading && ctx.accounts.length === 0) return "connected";
  // Case-insensitive like the backend's normalize_host (and lib/prRemote), so
  // a mixed-case remote URL host doesn't read as "needs-auth".
  const host = (forge.host ?? "github.com").toLowerCase();
  const bound = ctx.repoAccountRef?.host.toLowerCase() === host;
  const hasAccount = ctx.accounts.some((a) => a.host.toLowerCase() === host);
  if (ctx.accountsError) return "error";
  if (bound || hasAccount) return "connected";
  if (ctx.transportConfigured) return "transport-auth";
  return "needs-auth";
};
