// Zone B — the optional pull-request account. Deliberately subordinate to the
// git-profile zone: a repo is fully usable (commit/fetch/push) without one. The
// account binding itself lives in the accounts store; picking/connecting one is
// done on the Accounts settings tab, so the buttons here navigate there.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts } from "../../../../store/accounts";
import { useUi } from "../../../../store/ui";

export function PrAccountZone() {
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const setSettingsTab = useUi((s) => s.setSettingsTab);
  const account = accounts.find((a) => a.id === repoAccountId) ?? null;
  const goToAccounts = () => setSettingsTab("accounts");

  return (
    <div className="mt-7 pt-6 border-t border-black/[0.07] dark:border-white/[0.08]">
      <div className="flex items-center gap-2">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
          PULL-REQUEST ACCOUNT
        </div>
        <span className="px-1.5 h-[16px] grid place-items-center rounded text-[9.5px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 bg-black/[0.04] dark:bg-white/[0.06]">
          Optional
        </span>
      </div>
      <p className="mt-1.5 text-[12px] text-neutral-400 dark:text-neutral-500 text-pretty max-w-[460px]">
        Who you authenticate as for pull requests — separate from your commit author. Only affects PRs &amp;
        provider auth, never <span className="font-mono text-[11px]">git log</span>.
      </p>

      {account ? (
        <div className="mt-3 flex items-center gap-3 p-3 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]">
          <span
            className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center text-white text-[11px] font-bold"
            style={{ background: account.color }}
          >
            {account.username.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-neutral-900 dark:text-white">@{account.username}</span>
              <span className="text-[11.5px] text-neutral-500 dark:text-neutral-400">{account.host}</span>
              <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/12">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                PRs enabled
              </span>
            </div>
            <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
              Authenticates pull requests for this repo — not your commits.
            </div>
          </div>
          <button
            onClick={goToAccounts}
            className={cn(
              "shrink-0 text-[12.5px] font-medium px-3 h-8 rounded-lg text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-neutral-700 dark:hover:text-neutral-200 transition",
              focusRing,
            )}
          >
            Change
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 p-3 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02]">
          <span className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center bg-black/[0.04] dark:bg-white/[0.06] text-neutral-400 dark:text-neutral-500">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 21V9a9 9 0 0 0 9 9" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">No account</div>
            <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
              PRs are off for this repo. Commit, fetch &amp; push still work via your git profile.
            </div>
          </div>
          <button
            onClick={goToAccounts}
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-semibold text-neutral-600 dark:text-neutral-300 border border-black/10 dark:border-white/[0.12] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition",
              focusRing,
            )}
          >
            Connect account
          </button>
        </div>
      )}
    </div>
  );
}
