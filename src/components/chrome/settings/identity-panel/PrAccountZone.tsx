// Zone B — the optional pull-request account. Deliberately subordinate to the
// git-profile zone: a repo is fully usable (commit/fetch/push) without one.
// Binding here drives PR/push/fetch auth ONLY — never the commit identity
// (setRepoAccount is identity-free; commit author is the git profile in Zone A).
//
// Selection is scoped to the repo's PR remote (the default remote that drives
// the provider indicator and PR tab): accounts on a different host are shown
// but disabled with the reason, a known non-GitHub forge states that PRs
// aren't supported instead of offering accounts that can never work, and a
// bound account whose host no longer matches is flagged. The backend's
// HostMismatch check stays as the safety net — this moves the error from
// operation time to selection time.

import { useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { ForgeKind } from "../../../../lib/api";
import { accountMatchesPrRemote, prRemoteHost } from "../../../../lib/prRemote";
import { useAccounts, type Account } from "../../../../store/accounts";
import { useRepo } from "../../../../store/repo";
import { useUi } from "../../../../store/ui";
import { ArrowUpRightIcon } from "../../../ui/icons";

export function PrAccountZone() {
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const setRepoAccount = useAccounts((s) => s.setRepoAccount);
  const forge = useRepo((s) => s.forge);
  // This panel lives in the repo-scoped Repository settings window, so opening
  // the global Accounts tab means closing this window and opening global
  // Settings — not just flipping the (hidden) global tab state.
  const openSettings = useUi((s) => s.openSettings);
  const closeRepoSettings = useUi((s) => s.closeRepoSettings);
  const [picking, setPicking] = useState(false);
  const account = accounts.find((a) => a.id === repoAccountId) ?? null;

  // The PR remote's host scopes which accounts can work here. Unknown forge /
  // not-yet-loaded state falls back to unfiltered (the backend still guards).
  const prHost = prRemoteHost(forge);
  const hostMatches = (a: Account) => accountMatchesPrRemote(a, forge);
  const unsupportedForge =
    forge?.hasRemote && forge.kind !== null && forge.kind !== ForgeKind.GitHub ? forge.forge ?? forge.kind : null;
  const boundMismatch = account !== null && !hostMatches(account);

  // Accounts (like profiles) are a global library — hand off to Settings → Accounts.
  const manageAccounts = () => {
    closeRepoSettings();
    openSettings("accounts");
  };

  const pick = (id: string | null) => {
    // Defense in depth: never bind an account whose host can't work here. The
    // disabled row already blocks this, but the forge probe can land between
    // render and click — check against the *latest* forge state, not the
    // render's snapshot. Say why (the row looked enabled a moment ago) and
    // keep the picker open so the user sees the now-disabled row.
    if (id !== null) {
      const picked = accounts.find((a) => a.id === id);
      const latestForge = useRepo.getState().forge;
      if (picked && !accountMatchesPrRemote(picked, latestForge)) {
        useUi
          .getState()
          .showToast(
            `@${picked.username} is for ${picked.host} — this repo's remote is on ${latestForge?.host}`,
            "error",
          );
        return;
      }
    }
    void setRepoAccount(id);
    setPicking(false);
  };

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
          onClick={manageAccounts}
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] font-semibold text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          Manage accounts
          <ArrowUpRightIcon className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-neutral-400 dark:text-neutral-500 text-pretty max-w-[460px]">
        Who you authenticate as for pull requests — separate from your commit author. Only affects PRs &amp;
        provider auth, never <span className="font-mono text-[11px]">git log</span>.
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
                onClick={() => pick(null)}
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
      ) : picking ? (
        <div className="mt-3 rounded-xl border border-black/[0.08] bg-black/[0.015] p-2 dark:border-white/[0.1] dark:bg-white/[0.02]">
          <div role="radiogroup" aria-label="Pull-request account for this repo" className="flex flex-col gap-1">
            <AccountRow
              selected={repoAccountId === null}
              onSelect={() => pick(null)}
              label="No account"
              avatar={
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-black/[0.05] text-[11px] text-neutral-400 dark:bg-white/[0.06] dark:text-neutral-500">
                  —
                </span>
              }
              title="No account"
              subtitle="Pull requests off for this repo"
            />
            {accounts.map((a) => {
              const usable = hostMatches(a);
              return (
                <AccountRow
                  key={a.id}
                  selected={repoAccountId === a.id}
                  onSelect={() => pick(a.id)}
                  disabled={!usable}
                  label={`@${a.username}`}
                  avatar={
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] text-[11px] font-bold text-white"
                      style={{ background: a.color }}
                    >
                      {a.username.slice(0, 2).toUpperCase()}
                    </span>
                  }
                  title={`@${a.username}`}
                  subtitle={
                    usable
                      ? `${a.host} · authenticates PRs only`
                      : `${a.host} · different host than this repo's remote (${forge?.host})`
                  }
                />
              );
            })}
          </div>
          {prHost !== null && accounts.length > 0 && !accounts.some(hostMatches) && (
            <button
              onClick={manageAccounts}
              className={cn(
                "mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
                focusRing,
              )}
            >
              No accounts for {forge?.host} — add one in Accounts
            </button>
          )}
          {accounts.length === 0 && (
            <button
              onClick={manageAccounts}
              className={cn(
                "mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
                focusRing,
              )}
            >
              No accounts connected — add one in Accounts
            </button>
          )}
        </div>
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
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/12">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  PRs enabled
                </span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-neutral-500 dark:text-neutral-400 text-pretty">
              {boundMismatch
                ? `This repo's remote is on ${forge?.host} — pick an account for that host.`
                : "Authenticates pull requests for this repo — not your commits."}
            </div>
          </div>
          <button
            onClick={() => setPicking(true)}
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
            onClick={() => setPicking(true)}
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

function AccountRow({
  selected,
  onSelect,
  avatar,
  title,
  subtitle,
  label,
  disabled = false,
}: {
  selected: boolean;
  onSelect: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  label: string;
  /** Host doesn't match the repo's PR remote — visible but not selectable. */
  disabled?: boolean;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition",
        disabled
          ? "cursor-not-allowed opacity-50"
          : selected
            ? "bg-[var(--accent-soft)]"
            : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2",
          selected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-black/20 dark:border-white/25",
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-white" />}
      </span>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
        <div className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">{subtitle}</div>
      </div>
    </button>
  );
}
