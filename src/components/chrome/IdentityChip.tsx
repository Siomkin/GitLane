// Title-bar identity chip. Leads with the repo's commit identity — the git
// profile you commit as (Tier 1) — because that's the primary concept after
// the two-tier reframe. The popover is a status card, not a switcher: it shows
// the current commit identity and the current pull-request account (Tier 2),
// and every row opens the Identity settings page, which owns changing the
// bindings. The libraries themselves are managed globally in Settings →
// Profiles / Accounts.

import { useEffect, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useAccounts } from "../../store/accounts";
import { appliedProfileId, useProfiles } from "../../store/profiles";
import { profileInitials, selectProfile } from "../../lib/profiles";
import { accountMatchesPrRemote } from "../../lib/prRemote";
import { GitBranchIcon } from "../ui/icons";
import { repoLabel } from "../../lib/paths";

export function IdentityChip() {
  const summary = useRepo((s) => s.summary);
  const forge = useRepo((s) => s.forge);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const profiles = useProfiles((s) => s.profiles);
  const defaultIdentity = useProfiles((s) => s.defaultIdentity);
  const loadProfiles = useProfiles((s) => s.loadProfiles);
  const loadDefaultIdentity = useProfiles((s) => s.loadDefaultIdentity);
  const openRepoSettings = useUi((s) => s.openRepoSettings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, close, ref);

  useEffect(() => {
    loadProfiles();
    void loadDefaultIdentity();
  }, [loadProfiles, loadDefaultIdentity]);

  if (!summary) return null;

  const path = summary.path;
  const selection = selectProfile(repoIdentity, profiles, appliedProfileId(path));
  const activeProfile =
    selection.kind === "profile" ? profiles.find((p) => p.id === selection.id) ?? null : null;
  const account = accounts.find((a) => a.id === repoAccountId) ?? null;
  // Same semantics as the Identity panel: a bound account only works when its
  // host matches the PR remote's. Unknown forge → assume fine (backend guards).
  const accountMismatch = account !== null && !accountMatchesPrRemote(account, forge);

  const label =
    activeProfile?.label ??
    (selection.kind === "default"
      ? "Default identity"
      : selection.kind === "unmanaged"
        ? repoIdentity?.name ?? "Custom identity"
        : "Set identity");

  // What git config actually resolves to — shown under the commit-as row.
  const identityLine = repoIdentity
    ? `${repoIdentity.name} · ${repoIdentity.email}`
    : defaultIdentity
      ? `${defaultIdentity.name} · ${defaultIdentity.email}`
      : "No identity set in git config";

  const goIdentitySettings = () => {
    close();
    openRepoSettings("identity");
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Commit identity for this repository"
        className="flex h-8 items-center gap-1.5 rounded-full pl-1 pr-2.5 hover:bg-black/5 dark:hover:bg-white/5"
      >
        {activeProfile ? (
          <span
            className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white"
            style={{ background: activeProfile.color }}
          >
            {profileInitials(activeProfile.label)}
          </span>
        ) : (
          <span className="grid h-6 w-6 place-items-center rounded-full bg-black/[0.05] text-neutral-400 dark:bg-white/[0.06] dark:text-neutral-400">
            <GitBranchIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="max-w-[120px] truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
          {label}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-[34px] z-[70] w-[280px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800">
          <div className="flex items-center justify-between gap-2 border-b border-black/10 px-3.5 py-2.5 dark:border-white/10">
            <span className="text-[11px] font-semibold tracking-wider text-neutral-400">IDENTITY</span>
            <span className="min-w-0 truncate text-[12px] text-neutral-600 dark:text-neutral-300">
              {repoLabel(summary.workdir ?? summary.path)}
            </span>
          </div>

          {/* Status only — changing either binding lives on the Identity page. */}
          <StatusRow
            heading="COMMIT AS"
            onClick={goIdentitySettings}
            avatar={
              activeProfile ? (
                <span
                  className="grid h-[26px] w-[26px] place-items-center rounded-md text-[11px] font-bold text-white"
                  style={{ background: activeProfile.color }}
                >
                  {profileInitials(activeProfile.label)}
                </span>
              ) : (
                <span className="grid h-[26px] w-[26px] place-items-center rounded-md bg-black/[0.05] text-neutral-400 dark:bg-white/[0.06]">
                  <GitBranchIcon className="h-3.5 w-3.5" />
                </span>
              )
            }
            title={label}
            subtitle={identityLine}
          />

          <div className="border-t border-black/10 dark:border-white/10">
            <StatusRow
              heading="PULL REQUESTS AS"
              onClick={goIdentitySettings}
              avatar={
                account ? (
                  <span
                    className="grid h-[26px] w-[26px] place-items-center rounded-md text-[11px] font-bold text-white"
                    style={{ background: account.color }}
                  >
                    {account.username.slice(0, 2).toUpperCase()}
                  </span>
                ) : (
                  <span className="grid h-[26px] w-[26px] place-items-center rounded-md bg-black/[0.05] text-[11px] text-neutral-400 dark:bg-white/[0.06] dark:text-neutral-500">
                    —
                  </span>
                )
              }
              title={account ? `@${account.username}` : "No account"}
              subtitle={
                account
                  ? `${account.host} · ${accountMismatch ? "host mismatch" : account.healthy ? "PRs enabled" : "needs re-auth"}`
                  : "Pull requests off for this repo"
              }
            />
          </div>

          <button
            onClick={goIdentitySettings}
            className="flex w-full items-center gap-2 border-t border-black/10 px-3.5 py-2.5 text-left text-[12px] text-neutral-600 hover:bg-black/5 hover:text-neutral-800 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-neutral-100"
          >
            <GitBranchIcon className="h-3.5 w-3.5" /> Identity settings…
          </button>
        </div>
      )}
    </div>
  );
}

/** One display-only section (label + current value) that opens the Identity
 * settings page — the popover reports state, the page changes it. */
function StatusRow({
  heading,
  onClick,
  avatar,
  title,
  subtitle,
}: {
  heading: string;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <div className="px-3.5 pt-2.5 text-[11px] font-semibold tracking-wider text-neutral-400">{heading}</div>
      <button
        onClick={onClick}
        title="Change on the Identity settings page"
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
      >
        {avatar}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
          <div className="truncate text-[11px] text-neutral-400">{subtitle}</div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-600">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}
