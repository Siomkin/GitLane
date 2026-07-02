// An authenticated non-GitHub provider, shown in the connected accounts list.
// Consistency with GitHub: if you're signed in to the provider's CLI it appears
// here automatically (you don't "add" it in-app) — but plainly auth-only and
// PR-less, so it never reads as equivalent to a GitHub account.
//
// The real account identity is resolved by a separate network whoami, so this
// card renders as soon as auth is known and shows an identity skeleton until
// the whoami lands (it can take a couple of seconds — the user may navigate
// away otherwise).

import type { ForgeAuthStatus } from "../../../../lib/api";
import { accountHandle, providerInitials } from "./providers";

export function ConnectedForgeCard({
  status,
  loading = false,
}: {
  status: ForgeAuthStatus;
  loading?: boolean;
}) {
  const account = status.account;
  const resolving = loading && !account;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
        {providerInitials(status.forge)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">
            {account ? accountHandle(account) : status.forge}
          </span>
          {account && (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{status.forge}</span>
          )}
          <span className="grid h-[17px] place-items-center rounded-full bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
            Sign-in only
          </span>
        </div>
        {resolving ? (
          <div className="mt-1.5 flex items-center gap-2" aria-busy="true">
            <span className="h-3 w-44 animate-pulse rounded bg-black/10 dark:bg-white/15" />
            <span className="sr-only">Resolving account…</span>
          </div>
        ) : (
          <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
            {account?.name ? `${account.name} · ` : ""}
            {status.cli ? `signed in via ${status.cli}` : status.authMethod} · commit, fetch &amp; push use your git
            profile
          </div>
        )}
      </div>
    </div>
  );
}
