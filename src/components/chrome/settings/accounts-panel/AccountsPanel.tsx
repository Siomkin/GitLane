// Settings → Accounts. Your connected accounts, plus one "Add a provider" button
// that opens a provider picker → that provider's connect page. Accounts exist for
// **auth only** — pull requests and per-remote push/fetch credentials (picked in
// Repository settings → Remotes). Commit identity is the separate Identities tab;
// connecting an account never touches `user.name`/`user.email`.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { pullRequestLabel, supportsPullRequests, supportsPullRequestsViaForgeAuth } from "../../../../lib/forgeHelp";
import { useAccounts } from "../../../../store/accounts";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { credentialScopePath, detectRemoteUrl, forgeAuthProviderFor, type RemoteProvider } from "../../../../lib/remotes";
import { PROVIDERS, VISIBLE_PROVIDER_KEYS, type ProviderKey } from "./providers";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import { ConnectedForgeCard } from "./ConnectedForgeCard";
import { KeychainAccountCard } from "./KeychainAccountCard";
import { ProviderSection, type Capability } from "./ProviderSection";
import { ProviderPicker } from "./ProviderPicker";
import { ProviderConnect } from "./provider-connect";
import { TransportCredentialCard, type TransportCredentialAccount } from "./TransportCredentialCard";

type View = { k: "list" } | { k: "pick" } | { k: "connect"; provider: ProviderKey };

function providerKeyForRemote(provider: RemoteProvider): ProviderKey | null {
  const key = provider === "github" ? "github" : forgeAuthProviderFor(provider);
  return key && VISIBLE_PROVIDER_KEYS.includes(key) ? key : null;
}

function repoTransportCredentials(remotes: ReturnType<typeof useRepo.getState>["remotes"]): TransportCredentialAccount[] {
  const seen = new Set<string>();
  const credentials: TransportCredentialAccount[] = [];
  for (const remote of remotes) {
    const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
    const provider = providerKeyForRemote(info.provider);
    if (!provider || !info.user || !info.credentialHost) continue;
    const key = `${provider}\u0000${info.credentialHost}\u0000${info.user}`;
    if (seen.has(key)) continue;
    seen.add(key);
    credentials.push({
      provider,
      credentialHost: info.credentialHost,
      credentialPath: credentialScopePath(info) ?? info.path,
      login: info.user,
      remoteName: remote.name,
    });
  }
  return credentials;
}

export function AccountsPanel() {
  const accounts = useAccounts((s) => s.accounts);
  const accountsLoading = useAccounts((s) => s.accountsLoading);
  const accountsError = useAccounts((s) => s.accountsError);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const forgeAccountsLoading = useAccounts((s) => s.forgeAccountsLoading);
  const providerTokens = useAccounts((s) => s.providerTokens);
  const remotes = useRepo((s) => s.remotes);
  const loadAccounts = useAccounts((s) => s.loadAccounts);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const reconcileProviderTokens = useAccounts((s) => s.reconcileProviderTokens);
  const [view, setView] = useState<View>({ k: "list" });
  const connectIntent = useUi((s) => s.accountsConnectIntent);

  useEffect(() => {
    void loadForgeAuth();
    // Drop keychain-token cards whose secret vanished outside GitLane.
    void reconcileProviderTokens();
  }, [loadForgeAuth, reconcileProviderTokens]);

  // A queued "Fix authentication…" request lands straight on that provider's
  // connect view (the picker when the provider is unknown). Consumed once;
  // clearing is idempotent, so StrictMode's doubled effect is harmless.
  useEffect(() => {
    if (!connectIntent) return;
    setView(
      PROVIDERS.some((p) => p.key === connectIntent)
        ? { k: "connect", provider: connectIntent }
        : { k: "pick" },
    );
    useUi.getState().clearAccountsConnectIntent();
  }, [connectIntent]);

  const refresh = () => {
    void loadAccounts();
    void loadForgeAuth(true);
    void reconcileProviderTokens();
  };

  const connectedForges = forgeAuth.filter((f) => f.authenticated === true);
  const keychainAccounts = Object.values(providerTokens);
  const transportCredentials = repoTransportCredentials(remotes);
  const forgeAccountsLoadingSet = new Set(forgeAccountsLoading);

  // Group every connection under its provider so a row's provider is obvious from
  // the section header (GL-141), and only surface the providers in the picker —
  // a stray CLI sign-in on another forge is simply not shown here.
  const providerSections = VISIBLE_PROVIDER_KEYS.map((provider) => {
    const ghAccounts = provider === "github" ? accounts : [];
    const forges = provider === "github" ? [] : connectedForges.filter((f) => f.provider === provider);
    const tokens = keychainAccounts.filter((t) => t.provider === provider);
    const helpers = transportCredentials.filter((credential) => {
      if (credential.provider !== provider) return false;
      const login = credential.login.toLowerCase();
      if (
        provider === "github" &&
        ghAccounts.some(
          (account) =>
            account.login.toLowerCase() === login &&
            (credential.credentialHost === account.host.toLowerCase() ||
              credential.credentialHost.endsWith(`.${account.host.toLowerCase()}`)),
        )
      ) {
        return false;
      }
      if (
        forges.some(
          (status) => status.account?.username.toLowerCase() === login && status.authenticated === true,
        )
      ) {
        return false;
      }
      return !tokens.some(
        (token) =>
          token.credentialHost.toLowerCase() === credential.credentialHost &&
          (token.transportUsername ?? token.login).toLowerCase() === login,
      );
    });
    if (ghAccounts.length + forges.length + tokens.length + helpers.length === 0) return null;

    // Section-level capability, derived from the members (no repo scope): gh does
    // PRs; GitLab does MRs once glab is signed in or a token is stored; Bitbucket
    // does PRs only with a stored keychain token, else it is transport-only.
    let capability: Capability = null;
    if (provider === "github") {
      capability = ghAccounts.some((a) => a.healthy)
        ? { label: "Pull requests", tone: "pr" }
        : helpers.length > 0
          ? { label: "Transport only", tone: "muted" }
        : { label: "Needs re-auth", tone: "warn" };
    } else if (supportsPullRequests(provider)) {
      const prReady = (supportsPullRequestsViaForgeAuth(provider) && forges.length > 0) || tokens.length > 0;
      capability = prReady
        ? { label: pullRequestLabel(provider), tone: "pr" }
        : helpers.length > 0
          ? { label: "Transport only", tone: "muted" }
          : { label: "Sign-in only", tone: "muted" };
    } else {
      capability = { label: "Transport only", tone: "muted" };
    }

    return { provider, capability, ghAccounts, forges, tokens, helpers };
  }).filter((s): s is NonNullable<typeof s> => s !== null);

  const hasConnections = providerSections.length > 0;

  return (
    <>
      {/* HEADER */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Accounts</h2>
          <p className="mt-1.5 max-w-[520px] text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty">
            Provider sign-ins for{" "}
            <span className="font-semibold text-neutral-800 dark:text-neutral-100">pull requests and push auth</span>{" "}
            (picked per remote in Repository settings → Remotes). Who your commits are authored as is separate — see
            Identities.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className={cn(
            "h-9 shrink-0 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
            focusRing,
          )}
        >
          {accountsLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="mt-6">
        {view.k === "pick" ? (
          <ProviderPicker
            onBack={() => setView({ k: "list" })}
            onPick={(provider) => setView({ k: "connect", provider })}
          />
        ) : view.k === "connect" ? (
          <ProviderConnect
            meta={PROVIDERS.find((p) => p.key === view.provider) ?? PROVIDERS[0]}
            status={
              view.provider === "github" ? null : forgeAuth.find((f) => f.provider === view.provider) ?? null
            }
            accountLoading={forgeAccountsLoadingSet.has(view.provider)}
            onBack={() => setView({ k: "pick" })}
            onRefresh={refresh}
          />
        ) : (
          <>
            {accountsError && (
              <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12px] text-rose-500">
                {accountsError.includes("gh) not found")
                  ? "GitHub CLI (gh) not found. Install it from cli.github.com."
                  : accountsError}
              </div>
            )}

            {hasConnections ? (
              <div className="flex flex-col gap-5">
                {providerSections.map((sec) => (
                  <ProviderSection key={sec.provider} provider={sec.provider} capability={sec.capability}>
                    {sec.ghAccounts.map((account) => (
                      <ConnectedAccountCard key={account.id} account={account} />
                    ))}
                    {sec.forges.map((status) => (
                      <ConnectedForgeCard
                        key={status.provider}
                        status={status}
                        loading={forgeAccountsLoadingSet.has(status.provider)}
                      />
                    ))}
                    {sec.tokens.map((t) => (
                      <KeychainAccountCard
                        key={`${t.credentialHost}:${t.transportUsername ?? t.login}`}
                        account={{
                          provider: t.provider,
                          credentialHost: t.credentialHost,
                          login: t.login,
                          transportUsername: t.transportUsername,
                        }}
                      />
                    ))}
                    {sec.helpers.map((credential) => (
                      <TransportCredentialCard
                        key={`${credential.provider}:${credential.credentialHost}:${credential.credentialPath ?? ""}:${credential.login}:${credential.remoteName}`}
                        account={credential}
                      />
                    ))}
                  </ProviderSection>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
                No accounts connected yet. Add one to enable pull requests and push auth.
              </p>
            )}

            <button
              type="button"
              onClick={() => setView({ k: "pick" })}
              className={cn(
                "mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg border border-black/10 px-3.5 text-[13px] font-semibold text-neutral-700 transition hover:bg-black/[0.04] dark:border-white/[0.14] dark:text-neutral-200 dark:hover:bg-white/[0.06]",
                focusRing,
              )}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add a provider
            </button>
          </>
        )}
      </div>
    </>
  );
}
