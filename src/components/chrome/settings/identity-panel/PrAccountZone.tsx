// Zone B — the optional pull-request account. Deliberately subordinate to the
// git-profile zone: a repo is fully usable (commit/fetch/push) without one.
// The binding drives PR/push/fetch auth ONLY — never the commit identity
// (commit author is the git profile in Zone A).
//
// Since GL-129 the bindings are **per remote** and the picker lives in the
// Remotes panel (one mutation owner). This zone is a read-only summary of the
// default (PR) remote's binding — what the PR tab authenticates as — with a
// deep link to Remotes to change it. The unsupported-forge and stale-binding
// states stay as summary variants; clearing a stale binding is kept here as a
// one-click way out (it routes through the same store action the panel uses).

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { ForgeKind } from "../../../../lib/api";
import { accountMatchesPrRemote } from "../../../../lib/prRemote";
import { useAccounts } from "../../../../store/accounts";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { ArrowUpRightIcon } from "../../../ui/icons";

export function PrAccountZone() {
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const setRepoAccount = useAccounts((s) => s.setRepoAccount);
  const forge = useRepo((s) => s.forge);
  const remotes = useRepo((s) => s.remotes);
  const setRepoSettingsSection = useUi((s) => s.setRepoSettingsSection);
  const account = accounts.find((a) => a.id === repoAccountId) ?? null;

  const defaultRemote = remotes.find((r) => r.isDefault)?.name ?? null;
  const unsupportedForge =
    forge?.hasRemote && forge.kind !== null && forge.kind !== ForgeKind.GitHub ? forge.forge ?? forge.kind : null;
  const boundMismatch = account !== null && !accountMatchesPrRemote(account, forge);

  // Per-remote bindings are edited on the Remotes rows (GL-129) — same modal,
  // different section.
  const manageInRemotes = () => setRepoSettingsSection("remotes");

  return (
    <div className="mt-5 pt-5 border-t border-black/[0.07] dark:border-white/[0.08]">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            OPEN PULL REQUESTS AS · ACCOUNT
          </div>
          <span className="px-1.5 h-[16px] grid place-items-center rounded text-[9.5px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500 bg-black/[0.04] dark:bg-white/[0.06]">
            Optional
          </span>
        </div>
        <button
          onClick={manageInRemotes}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] font-semibold text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          Manage in Remotes
          <ArrowUpRightIcon className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-neutral-400 dark:text-neutral-500 text-pretty max-w-[460px]">
        Who you authenticate as for pull requests — separate from your commit author. Each remote
        picks its own push account in Remotes; PRs follow the default remote
        {defaultRemote ? <span className="font-mono text-[11px]"> ({defaultRemote})</span> : null}.
      </p>

      {unsupportedForge ? (
        <>
          <div className="mt-3 flex items-center gap-3 p-3 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02]">
            <span className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center bg-black/[0.04] dark:bg-white/[0.06] text-neutral-400 dark:text-neutral-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M17.5 19a4.5 4.5 0 1 0-.7-8.95 6 6 0 0 0-11.65 1.6A3.75 3.75 0 0 0 6 19z" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
                Pull requests aren&apos;t supported for {unsupportedForge} yet
              </div>
              <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
                Commit, fetch &amp; push still work via your git profile — no account needed.
              </div>
            </div>
          </div>
          {/* A binding left over from when this repo pointed at GitHub would
              otherwise be invisible here — and it still feeds push/fetch auth.
              Surface it with a way out. */}
          {account && (
            <div className="mt-2 flex items-center gap-3 p-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] dark:border-amber-400/20">
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
                  <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/12">
                    not usable here
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
                  Bound earlier — this repo&apos;s remote is on {forge?.host}. Fetch &amp; push as this account
                  will fail here; clear it to use your git credentials instead.
                </div>
              </div>
              <button
                onClick={() => void setRepoAccount(null)}
                className={cn(
                  "shrink-0 text-[12.5px] font-medium px-3 h-8 rounded-lg text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-neutral-700 dark:hover:text-neutral-200 transition",
                  focusRing,
                )}
              >
                Clear
              </button>
            </div>
          )}
        </>
      ) : account ? (
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
              {boundMismatch ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/12"
                  title={`This account is for ${account.host}; the repo's remote is ${forge?.host}. PR operations and authenticated fetch/push will fail until they match.`}
                >
                  host mismatch
                </span>
              ) : !account.healthy ? (
                <span
                  className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/12"
                  title={`${account.healthError || "gh reported this account's credentials as broken."} Run \`gh auth login --hostname ${account.host}\` to re-authenticate.`}
                >
                  needs re-auth
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/12">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  PRs enabled
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
              {boundMismatch
                ? `This repo's remote is on ${forge?.host} — pick an account for that host in Remotes.`
                : "Authenticates pull requests for this repo — not your commits."}
            </div>
          </div>
          <button
            onClick={manageInRemotes}
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
            onClick={manageInRemotes}
            className={cn(
              "shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-semibold text-neutral-600 dark:text-neutral-300 border border-black/10 dark:border-white/[0.12] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition",
            focusRing,
            )}
          >
            Choose account
          </button>
        </div>
      )}
    </div>
  );
}
