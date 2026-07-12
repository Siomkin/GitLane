// The connect path for one provider the user picked. Each state is visually and
// verbally distinct so "not installed", "not signed in", "manual", and "signed
// in but no PR support" never read alike — and none looks like a broken account.
// Provider CLI paths are preferred when they enable PR/MR features; GCM/helper
// and SSH remain visible as transport-only fallbacks.

import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import type { ForgeAuthStatus } from "@/lib/api";
import { providerInitials, type ProviderMeta } from "@/components/chrome/settings/accounts-panel/providers";
import { GithubConnect } from "./GithubConnect";
import { ForgeConnect } from "./ForgeConnect";
import { refreshBtnCls } from "./ui";

export function ProviderConnect({
  meta,
  status,
  accountLoading = false,
  onBack,
  onRefresh,
}: {
  meta: ProviderMeta;
  /** The provider's auth probe — `null` for GitHub (handled by the gh path). */
  status: ForgeAuthStatus | null;
  /** The background whoami for this provider is in flight (identity resolving). */
  accountLoading?: boolean;
  /** Back affordance for the picker-flow embedding; omit in the persistent
   * provider-sidebar layout (Settings → Accounts), where there is no "back". */
  onBack?: () => void;
  onRefresh: () => void;
}) {
  const refresh = (
    <button type="button" onClick={onRefresh} className={cn(refreshBtnCls, focusRing)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
        <path d="M21 3v5h-5" />
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        <path d="M3 21v-5h5" />
      </svg>
      Refresh
    </button>
  );

  return (
    <div className="rounded-xl border border-black/[0.08] bg-black/[0.015] p-4 dark:border-white/[0.1] dark:bg-white/[0.02]">
      {/* header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <button type="button"
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
        )}
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.06] text-[11px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
          {providerInitials(meta.name)}
        </span>
        <div className="text-[14px] font-semibold text-neutral-900 dark:text-white">Connect {meta.name}</div>
        {meta.prSupported ? (
          <span className="ml-auto inline-flex h-[18px] items-center rounded-full bg-emerald-500/12 px-2 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            Full support
          </span>
        ) : (
          <span className="ml-auto inline-flex h-[18px] items-center rounded-full bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
            Sign-in only
          </span>
        )}
      </div>

      <div className="mt-3.5">
        {meta.key === "github" ? (
          <GithubConnect refresh={refresh} />
        ) : status ? (
          <ForgeConnect status={status} accountLoading={accountLoading} refresh={refresh} />
        ) : (
          <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400">No status available — press Refresh.</p>
        )}
      </div>
    </div>
  );
}
