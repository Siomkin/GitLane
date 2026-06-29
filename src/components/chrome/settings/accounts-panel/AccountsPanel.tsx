// Settings → Accounts. Tier 2 of the identity model: provider accounts are the
// optional pull-request layer, not a requirement to use a repo. Add-account
// model — connected accounts (today: GitHub via `gh`) plus an "Add account"
// picker, instead of a permanent card for every provider regardless of tooling.
// Faithful port of the "Settings — Identity & Accounts" design (AcctPanel).

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useUi } from "../../../../store/ui";
import { useAccounts } from "../../../../store/accounts";
import { InlineCode } from "../../../ui/InlineCode";
import { PROVIDERS, type ProviderKey } from "./providers";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import { ConnectedForgeCard } from "./ConnectedForgeCard";
import { AddAccountPicker } from "./AddAccountPicker";
import { ProviderConnect } from "./ProviderConnect";

export function AccountsPanel() {
  const accounts = useAccounts((s) => s.accounts);
  const accountsLoading = useAccounts((s) => s.accountsLoading);
  const accountsError = useAccounts((s) => s.accountsError);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const forgeAccountsLoading = useAccounts((s) => s.forgeAccountsLoading);
  const loadAccounts = useAccounts((s) => s.loadAccounts);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const setSettingsTab = useUi((s) => s.setSettingsTab);

  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<ProviderKey | null>(null);

  useEffect(() => {
    void loadForgeAuth();
  }, [loadForgeAuth]);

  const refresh = () => {
    void loadAccounts();
    void loadForgeAuth(true);
  };

  const startAdding = () => {
    setSelected(null);
    setAdding(true);
  };
  const closeAdding = () => {
    setAdding(false);
    setSelected(null);
  };

  const selectedMeta = PROVIDERS.find((p) => p.key === selected) ?? null;
  const selectedStatus =
    selected && selected !== "github" ? forgeAuth.find((f) => f.provider === selected) ?? null : null;
  // Authenticated non-GitHub providers are "connected" (auth-only) and listed
  // alongside GitHub — being signed in is what makes them appear, same as gh.
  const connectedForges = forgeAuth.filter((f) => f.authenticated === true);
  const nothingConnected = accounts.length === 0 && connectedForges.length === 0;

  return (
    <>
      {/* HEADER */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Accounts</h2>
          <p className="mt-1.5 max-w-[460px] text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty">
            Accounts are <span className="font-semibold text-neutral-800 dark:text-neutral-100">optional</span> — they
            enable pull requests. Commit, fetch &amp; push work with just a git profile in{" "}
            <button
              onClick={() => setSettingsTab("repo")}
              className={cn(
                "font-semibold text-neutral-800 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-100 dark:hover:text-white",
                focusRing,
              )}
            >
              Identity
            </button>
            .
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={refresh}
            className={cn(
              "h-9 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
              focusRing,
            )}
          >
            {accountsLoading ? "Refreshing…" : "Refresh"}
          </button>
          {!adding && (
            <button
              onClick={startAdding}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-semibold text-white transition hover:brightness-110",
                focusRing,
              )}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add account
            </button>
          )}
        </div>
      </div>

      <div className="mt-6">
        {accountsError && !adding && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12px] text-rose-500">
            {accountsError.includes("gh) not found")
              ? "GitHub CLI (gh) not found. Install it from cli.github.com."
              : accountsError}
          </div>
        )}

        {adding ? (
          selectedMeta ? (
            <ProviderConnect
              meta={selectedMeta}
              status={selectedStatus}
              onBack={() => setSelected(null)}
              onRefresh={refresh}
            />
          ) : (
            <AddAccountPicker onPick={setSelected} onClose={closeAdding} />
          )
        ) : nothingConnected && !accountsLoading && !accountsError ? (
          <EmptyState onAdd={startAdding} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {accounts.map((account) => (
              <ConnectedAccountCard key={account.id} account={account} />
            ))}
            {connectedForges.map((status) => (
              <ConnectedForgeCard
                key={status.provider}
                status={status}
                loading={forgeAccountsLoading.includes(status.provider)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-black/15 bg-black/[0.015] p-6 text-center dark:border-white/[0.14] dark:bg-white/[0.02]">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-[13px] bg-black/[0.05] text-neutral-400 dark:bg-white/[0.07] dark:text-neutral-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      </div>
      <div className="mt-3 text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">No accounts yet</div>
      <p className="mx-auto mt-1.5 max-w-[360px] text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400 text-pretty">
        You don’t need one to use this repo — a git profile already handles commit, fetch &amp; push. Add an account to
        enable pull requests. GitLane reads accounts from provider CLIs like <InlineCode>gh</InlineCode>.
      </p>
      <button
        onClick={onAdd}
        className={cn(
          "mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110",
          focusRing,
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add account
      </button>
    </div>
  );
}
