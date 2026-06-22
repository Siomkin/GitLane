// Accounts settings: the global GitHub identities the `gh` CLI is logged into.
// Read-only here (discovery + status) — which account a repo *uses* is chosen in
// the Repository Identity panel. All state lives in the accounts store.

import { useEffect } from "react";
import { focusRing } from "../../../lib/ui";
import { useUi } from "../../../store/ui";
import { useAccounts } from "../../../store/accounts";
import { InlineCode } from "../../ui/InlineCode";

export function AccountsPanel() {
  const accounts = useAccounts((s) => s.accounts);
  const accountsLoading = useAccounts((s) => s.accountsLoading);
  const accountsError = useAccounts((s) => s.accountsError);
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const forgeAuthError = useAccounts((s) => s.forgeAuthError);
  const loadAccounts = useAccounts((s) => s.loadAccounts);
  const loadForgeAuth = useAccounts((s) => s.loadForgeAuth);
  const setSettingsTab = useUi((s) => s.setSettingsTab);

  useEffect(() => {
    void loadForgeAuth();
  }, [loadForgeAuth]);

  const refresh = () => {
    void loadAccounts();
    void loadForgeAuth(true);
  };

  return (
    <>
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[19px] font-bold text-neutral-800 dark:text-neutral-100">Accounts</div>
        <button
          onClick={refresh}
          className={`h-9 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-medium text-white transition hover:brightness-110 ${focusRing}`}
        >
          {accountsLoading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="mb-[22px] text-[13px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Global GitHub accounts, from the GitHub CLI (<InlineCode>gh</InlineCode>). Run{" "}
        <InlineCode>gh auth login</InlineCode> in a terminal to add one, then Refresh. To choose
        which account a repository uses, open{" "}
        <button
          onClick={() => setSettingsTab("repo")}
          className={`font-semibold text-neutral-800 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-100 dark:hover:text-white ${focusRing}`}
        >
          This repository → Identity
        </button>
        .
      </div>

      {accountsError && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12px] text-rose-500">
          {accountsError.includes("gh) not found")
            ? "GitHub CLI (gh) not found. Install it from cli.github.com."
            : accountsError}
        </div>
      )}

      {!accountsError && accounts.length === 0 && !accountsLoading && (
        <div className="rounded-xl border border-black/10 bg-black/[0.03] p-5 text-[13px] leading-relaxed text-neutral-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400">
          No GitHub accounts found. Run <InlineCode>gh auth login</InlineCode>, then press Refresh.
        </div>
      )}

      {accounts.map((account) => (
        <div
          key={account.id}
          className="mb-2.5 flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.03] px-[15px] py-[13px] dark:border-white/10 dark:bg-white/[0.04]"
        >
          <span
            className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-[13px] font-bold text-white"
            style={{ background: account.color }}
          >
            {account.username.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-neutral-800 dark:text-neutral-100">@{account.username}</span>
              <span className="text-[11px] text-neutral-400">{account.host}</span>
              {account.active && (
                <span className="rounded-full border border-black/10 bg-black/[0.05] px-2 py-px text-[10.5px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400">
                  active
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-neutral-400">
              {account.name} · {account.email || account.host}
            </div>
          </div>
        </div>
      ))}

      <div className="mt-7 border-t border-black/10 pt-5 dark:border-white/10">
        <div className="mb-2 text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
          Other provider authentication
        </div>
        <div className="mb-3 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          Auth status only. Pull requests remain GitHub-only in this build.
        </div>
        {forgeAuthError && (
          <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-3 text-[12px] text-rose-500">
            {forgeAuthError}
          </div>
        )}
        {forgeAuth.map((provider) => (
          <div
            key={provider.provider}
            className="mb-2.5 flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.03] px-[15px] py-[13px] dark:border-white/10 dark:bg-white/[0.04]"
          >
            <span className="grid h-[38px] w-[38px] place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
              {provider.forge.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold text-neutral-800 dark:text-neutral-100">
                  {provider.forge}
                </span>
                <StatusBadge status={authStatus(provider)} />
              </div>
              <div className="mt-0.5 truncate text-[11.5px] text-neutral-400">
                {provider.cli ? `${provider.authMethod} · ${provider.loginCommand}` : provider.authMethod}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function authStatus(provider: { cli: string | null; available: boolean; authenticated: boolean | null }) {
  if (provider.cli === null) return "manual";
  if (!provider.available) return "missing";
  return provider.authenticated ? "signed-in" : "not-signed-in";
}

function StatusBadge({ status }: { status: "signed-in" | "not-signed-in" | "missing" | "manual" }) {
  const label =
    status === "signed-in"
      ? "signed in"
      : status === "not-signed-in"
        ? "not signed in"
        : status === "missing"
          ? "CLI missing"
          : "manual";
  return (
    <span className="rounded-full border border-black/10 bg-black/[0.05] px-2 py-px text-[10.5px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400">
      {label}
    </span>
  );
}
