// Settings → Accounts. Provider-first navigation: a persistent provider list
// on the left, the selected provider's page on the right. Accounts exist for
// **auth only** — pull requests and per-remote push/fetch credentials (picked
// in Repository settings → Remotes). Commit identity is the separate
// Identities tab; connecting an account never touches `user.name`/`user.email`.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useUi } from "../../../../store/ui";
import { useAccounts } from "../../../../store/accounts";
import { cliStatusLine, providerInitials, PROVIDERS, type ProviderKey } from "./providers";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import { ConnectedForgeCard } from "./ConnectedForgeCard";
import { ProviderConnect } from "./ProviderConnect";

export function AccountsPanel() {
  const accounts = useAccounts((s) => s.accounts);
  const accountsLoading = useAccounts((s) => s.accountsLoading);
  const accountsError = useAccounts((s) => s.accountsError);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const forgeAccountsLoading = useAccounts((s) => s.forgeAccountsLoading);
  const loadAccounts = useAccounts((s) => s.loadAccounts);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const openGithubSignin = useUi((s) => s.openGithubSignin);
  const [selected, setSelected] = useState<ProviderKey>("github");

  useEffect(() => {
    void loadForgeAuth();
  }, [loadForgeAuth]);

  const refresh = () => {
    void loadAccounts();
    void loadForgeAuth(true);
  };

  const selectedMeta = PROVIDERS.find((p) => p.key === selected) ?? PROVIDERS[0];
  const selectedStatus =
    selected === "github" ? null : forgeAuth.find((f) => f.provider === selected) ?? null;

  const statusLine = (key: ProviderKey): string | null => {
    if (key === "github") {
      if (accountsLoading) return "Loading…";
      return accounts.length > 0
        ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} connected`
        : "Not connected";
    }
    return cliStatusLine(forgeAuth.find((f) => f.provider === key));
  };

  return (
    <>
      {/* HEADER */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Accounts</h2>
          <p className="mt-1.5 max-w-[520px] text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty">
            Provider sign-ins for{" "}
            <span className="font-semibold text-neutral-800 dark:text-neutral-100">pull requests and push auth</span>{" "}
            (picked per remote in Repository settings → Remotes). Who your commits are authored as
            is separate — see Identities.
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

      <div className="mt-6 flex items-start gap-5">
        {/* Provider list — persistent, GitKraken-style. */}
        <nav aria-label="Providers" className="flex w-[210px] flex-none flex-col gap-0.5">
          {PROVIDERS.map((p) => {
            const line = statusLine(p.key);
            return (
              <button
                key={p.key}
                onClick={() => setSelected(p.key)}
                aria-current={selected === p.key ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left",
                  selected === p.key
                    ? "bg-black/[0.05] dark:bg-white/[0.06]"
                    : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                  focusRing,
                )}
              >
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-black/[0.06] text-[10px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
                  {providerInitials(p.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px]",
                      selected === p.key
                        ? "font-semibold text-neutral-800 dark:text-neutral-100"
                        : "font-medium text-neutral-600 dark:text-neutral-300",
                    )}
                  >
                    {p.name}
                  </span>
                  {line && (
                    <span className="block truncate text-[11px] text-neutral-400 dark:text-neutral-500">{line}</span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Provider page. */}
        <div className="min-w-0 flex-1">
          {selected === "github" ? (
            <>
              {accountsError && (
                <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12px] text-rose-500">
                  {accountsError.includes("gh) not found")
                    ? "GitHub CLI (gh) not found. Install it from cli.github.com."
                    : accountsError}
                </div>
              )}
              {accounts.length > 0 && (
                <div className="mb-4 flex flex-col gap-2.5">
                  {accounts.map((account) => (
                    <ConnectedAccountCard key={account.id} account={account} />
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openGithubSignin("github.com")}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110",
                    focusRing,
                  )}
                >
                  {accounts.length > 0 ? "Add another account" : "Sign in to GitHub"}
                </button>
                <span className="text-[11.5px] text-neutral-400 dark:text-neutral-500">
                  Enterprise hosts are picked in the sign-in dialog.
                </span>
              </div>
            </>
          ) : (
            <>
              {selectedStatus?.authenticated === true && (
                <div className="mb-4">
                  <ConnectedForgeCard
                    status={selectedStatus}
                    loading={forgeAccountsLoading.includes(selected)}
                  />
                </div>
              )}
              <ProviderConnect
                meta={selectedMeta}
                status={selectedStatus}
                accountLoading={forgeAccountsLoading.includes(selected)}
                onRefresh={refresh}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
