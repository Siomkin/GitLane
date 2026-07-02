// The add-account provider picker. Replaces the old "permanent card per
// provider" list — providers only appear here, when the user is actively adding
// one, with an honest capability hint (GitHub = full support, others =
// sign-in only) and the live CLI status (installed / signed in) under each
// name, so it's visible up front which providers are already usable. Picking
// one opens its connect path.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts } from "../../../../store/accounts";
import { capabilityHint, cliStatusLine, PROVIDERS, providerInitials, type ProviderKey, type ProviderMeta } from "./providers";

export function AddAccountPicker({
  onPick,
  onClose,
}: {
  onPick: (key: ProviderKey) => void;
  onClose: () => void;
}) {
  const forgeAuth = useAccounts((s) => s.forgeAuth);
  const accounts = useAccounts((s) => s.accounts);
  const accountsError = useAccounts((s) => s.accountsError);

  // GitHub isn't in the forge-auth probes — derive its gh status from the
  // account list the panel already loads.
  const statusLine = (p: ProviderMeta): string | null => {
    if (p.key !== "github") return cliStatusLine(forgeAuth.find((f) => f.provider === p.key));
    if (accountsError?.includes("gh) not found")) return "gh CLI not installed";
    if (accounts.length > 0)
      return `Signed in via gh (${accounts.length} account${accounts.length === 1 ? "" : "s"})`;
    return "gh installed — not signed in";
  };
  const signedIn = (p: ProviderMeta): boolean =>
    p.key === "github"
      ? accounts.length > 0
      : forgeAuth.find((f) => f.provider === p.key)?.authenticated === true;

  return (
    <div className="rounded-xl border border-black/[0.08] bg-black/[0.015] p-3 dark:border-white/[0.1] dark:bg-white/[0.02]">
      <div className="mb-1 flex items-center justify-between px-1">
        <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">Add an account</div>
        <button
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "grid h-7 w-7 place-items-center rounded-lg text-neutral-400 transition hover:bg-black/5 dark:hover:bg-white/10",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            onClick={() => onPick(p.key)}
            className={cn(
              "group flex items-center gap-3 rounded-lg border border-transparent p-2 text-left transition hover:border-black/10 hover:bg-black/[0.03] dark:hover:border-white/10 dark:hover:bg-white/[0.04]",
              focusRing,
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
              {providerInitials(p.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">{p.name}</span>
              {statusLine(p) && (
                <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-neutral-400 dark:text-neutral-500">
                  {signedIn(p) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />}
                  {statusLine(p)}
                </span>
              )}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                p.prSupported
                  ? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                  : "bg-black/[0.05] text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400",
              )}
            >
              {capabilityHint(p)}
            </span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4 text-neutral-300 transition group-hover:text-neutral-400 dark:text-neutral-600"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
