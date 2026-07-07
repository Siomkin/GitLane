// Settings → Accounts. Your connected accounts, plus one "Add a provider" button
// that opens a provider picker → that provider's connect page. Accounts exist for
// **auth only** — pull requests and per-remote push/fetch credentials (picked in
// Repository settings → Remotes). Commit identity is the separate Identities tab;
// connecting an account never touches `user.name`/`user.email`.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts } from "../../../../store/accounts";
import { PROVIDERS, type ProviderKey } from "./providers";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import { ConnectedForgeCard } from "./ConnectedForgeCard";
import { KeychainAccountCard } from "./KeychainAccountCard";
import { ProviderPicker } from "./ProviderPicker";
import { ProviderConnect } from "./provider-connect";

type View = { k: "list" } | { k: "pick" } | { k: "connect"; provider: ProviderKey };

export function AccountsPanel() {
  const accounts = useAccounts((s) => s.accounts);
  const accountsLoading = useAccounts((s) => s.accountsLoading);
  const accountsError = useAccounts((s) => s.accountsError);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const forgeAccountsLoading = useAccounts((s) => s.forgeAccountsLoading);
  const providerTokens = useAccounts((s) => s.providerTokens);
  const loadAccounts = useAccounts((s) => s.loadAccounts);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const reconcileProviderTokens = useAccounts((s) => s.reconcileProviderTokens);
  const [view, setView] = useState<View>({ k: "list" });

  useEffect(() => {
    void loadForgeAuth();
    // Drop keychain-token cards whose secret vanished outside GitLane.
    void reconcileProviderTokens();
  }, [loadForgeAuth, reconcileProviderTokens]);

  const refresh = () => {
    void loadAccounts();
    void loadForgeAuth(true);
    void reconcileProviderTokens();
  };

  const connectedForges = forgeAuth.filter((f) => f.authenticated === true);
  const keychainAccounts = Object.values(providerTokens);
  const hasConnections = accounts.length > 0 || connectedForges.length > 0 || keychainAccounts.length > 0;

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
            accountLoading={forgeAccountsLoading.includes(view.provider)}
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
              <div className="flex flex-col gap-2.5">
                {accounts.map((account) => (
                  <ConnectedAccountCard key={account.id} account={account} />
                ))}
                {connectedForges.map((status) => (
                  <ConnectedForgeCard
                    key={status.provider}
                    status={status}
                    loading={forgeAccountsLoading.includes(status.provider as ProviderKey)}
                  />
                ))}
                {keychainAccounts.map((t) => (
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
              </div>
            ) : (
              <p className="text-[13px] text-neutral-500 dark:text-neutral-400">
                No accounts connected yet. Add one to enable pull requests and push auth.
              </p>
            )}

            <button
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
