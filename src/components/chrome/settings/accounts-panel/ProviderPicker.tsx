// The "Add a provider" grid: pick which provider to connect. Replaces the
// always-on left rail — providers live behind this one button instead of taking
// permanent space, since only GitHub is full-support and the rest are rarely
// used. Each tile shows the provider's capability + local CLI/account state so
// the pick is informed.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts } from "../../../../store/accounts";
import { capabilityHint, cliStatusLine, providerInitials, PROVIDERS, type ProviderKey } from "./providers";

export function ProviderPicker({
  onPick,
  onBack,
}: {
  onPick: (key: ProviderKey) => void;
  onBack: () => void;
}) {
  const accounts = useAccounts((s) => s.accounts);
  const forgeAuth = useAccounts((s) => s.forgeAuth);

  const line = (key: ProviderKey): string | null => {
    if (key === "github") {
      return accounts.length > 0
        ? `${accounts.length} account${accounts.length > 1 ? "s" : ""} connected`
        : "Not connected";
    }
    return cliStatusLine(forgeAuth.find((f) => f.provider === key));
  };

  return (
    <div className="rounded-xl border border-black/[0.08] bg-black/[0.015] p-4 dark:border-white/[0.1] dark:bg-white/[0.02]">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          aria-label="Back"
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </button>
        <div className="text-[14px] font-semibold text-neutral-900 dark:text-white">Add a provider</div>
      </div>

      <div className="mt-3.5 grid gap-2 sm:grid-cols-2">
        {PROVIDERS.map((p) => {
          const status = line(p.key);
          return (
            <button
              key={p.key}
              onClick={() => onPick(p.key)}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border border-black/[0.08] bg-white p-3 text-left transition hover:border-black/[0.16] hover:bg-black/[0.015] dark:border-white/[0.1] dark:bg-neutral-900/40 dark:hover:border-white/20",
                focusRing,
              )}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
                {providerInitials(p.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
                    {p.name}
                  </span>
                  {p.prSupported ? (
                    <span className="inline-flex h-[16px] items-center rounded-full bg-emerald-500/12 px-1.5 text-[9.5px] font-semibold text-emerald-600 dark:text-emerald-400">
                      Full support
                    </span>
                  ) : (
                    <span className="inline-flex h-[16px] items-center rounded-full bg-black/[0.05] px-1.5 text-[9.5px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
                      {capabilityHint(p)}
                    </span>
                  )}
                </span>
                {status && (
                  <span className="mt-0.5 block truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                    {status}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
