// A connected GitHub account — the only provider with real identity today, so
// it gets the richest card: avatar, @login, host, active state, name/email, an
// explicit "PRs enabled" marker that non-GitHub providers never show, and a
// Sign out action (`gh auth logout` for exactly this account).

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts, type Account } from "../../../../store/accounts";
import { useUi } from "../../../../store/ui";

export function ConnectedAccountCard({ account }: { account: Account }) {
  const signOutGithub = useAccounts((s) => s.signOutGithub);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const signOut = () =>
    requestConfirm({
      title: `Sign @${account.username} out of GitHub?`,
      message:
        "Its stored credentials are removed from gh. Remotes pinned to this account fall back to your system git credentials until you sign in again.",
      confirmLabel: "Sign out",
      danger: true,
      onConfirm: () => void signOutGithub(account),
    });
  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <span
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] text-[13px] font-bold text-white"
        style={{ background: account.color }}
      >
        {account.username.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">@{account.username}</span>
          <span className="inline-flex items-center gap-1 text-[11.5px] text-neutral-500 dark:text-neutral-400">
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
              <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .6 1.3.2 2.3.1 2.6a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.8v2.6c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
            </svg>
            {account.host}
          </span>
          {account.active && (
            <span className="grid h-[17px] place-items-center rounded-full border border-black/10 bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400">
              active
            </span>
          )}
          {account.healthy ? (
            <span className="inline-flex h-[17px] items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              PRs enabled
            </span>
          ) : (
            <span
              className="inline-flex h-[17px] items-center gap-1 rounded-full bg-amber-500/12 px-1.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
              title={`${account.healthError || "gh reported this account's credentials as broken."} Run \`gh auth login --hostname ${account.host}\` to re-authenticate.`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              needs re-auth
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
          {account.name} · {account.email || account.host}
        </div>
      </div>
      <button
        onClick={signOut}
        className={cn(
          "shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400",
          focusRing,
        )}
      >
        Sign out
      </button>
    </div>
  );
}
