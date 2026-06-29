// Title-bar identity chip. Leads with the repo's COMMIT IDENTITY — the git
// profile you commit as (Tier 1) — because that's the primary concept after the
// two-tier reframe. The pull-request account (Tier 2) is shown as a subordinate
// line in the popover. Quick-switch profiles here; full management (incl. the PR
// account binding and signing) lives in Settings → Identity.

import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useDismiss } from "../../hooks/useDismiss";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useAccounts } from "../../store/accounts";
import { appliedProfileId, useProfiles } from "../../store/profiles";
import { profileInitials, selectProfile } from "../../lib/profiles";
import { CheckIcon } from "../ui/icons";
import { repoLabel } from "../../lib/paths";

function DefaultIdentityIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="6" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="12" r="2.4" />
      <path d="M6 8.4v7.2" />
      <path d="M18 9.6c0 4-6 1.6-6 6" />
    </svg>
  );
}

export function IdentityChip() {
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const profiles = useProfiles((s) => s.profiles);
  const defaultIdentity = useProfiles((s) => s.defaultIdentity);
  const loadProfiles = useProfiles((s) => s.loadProfiles);
  const loadDefaultIdentity = useProfiles((s) => s.loadDefaultIdentity);
  const applyProfile = useProfiles((s) => s.applyProfile);
  const openSettings = useUi((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

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

  const label =
    activeProfile?.label ??
    (selection.kind === "default"
      ? "Default identity"
      : selection.kind === "unmanaged"
        ? repoIdentity?.name ?? "Custom identity"
        : "Set identity");

  const apply = (id: string | null) => {
    void applyProfile(id);
    setOpen(false);
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
            <DefaultIdentityIcon className="h-3.5 w-3.5" />
          </span>
        )}
        <span className="max-w-[120px] truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
          {label}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-[34px] z-[70] w-[280px] overflow-hidden rounded-xl border border-black/10 bg-white shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)] dark:border-white/10 dark:bg-neutral-800">
          <div className="border-b border-black/10 px-3.5 py-2.5 dark:border-white/10">
            <div className="text-[11px] font-semibold tracking-wider text-neutral-400">COMMIT IDENTITY</div>
            <div className="mt-0.5 truncate text-[12px] text-neutral-600 dark:text-neutral-300">
              {repoLabel(summary.workdir ?? summary.path)}
            </div>
          </div>

          <div className="max-h-[260px] overflow-auto py-1">
            <Row
              selected={selection.kind === "default"}
              onClick={() => apply(null)}
              avatar={
                <span className="grid h-[26px] w-[26px] place-items-center rounded-md bg-black/[0.05] text-neutral-400 dark:bg-white/[0.06]">
                  <DefaultIdentityIcon className="h-3.5 w-3.5" />
                </span>
              }
              title="Default git identity"
              subtitle={defaultIdentity ? defaultIdentity.email : "Repo / global git config"}
            />
            {profiles.map((p) => (
              <Row
                key={p.id}
                selected={activeProfile?.id === p.id}
                onClick={() => apply(p.id)}
                avatar={
                  <span
                    className="grid h-[26px] w-[26px] place-items-center rounded-md text-[11px] font-bold text-white"
                    style={{ background: p.color }}
                  >
                    {profileInitials(p.label)}
                  </span>
                }
                title={p.label}
                subtitle={`${p.name} · ${p.email}`}
              />
            ))}
            {profiles.length === 0 && (
              <div className="px-3.5 py-3 text-[11.5px] leading-relaxed text-neutral-400">
                No saved profiles yet. Create one in Identity settings.
              </div>
            )}
          </div>

          {/* Secondary: the optional pull-request account (Tier 2). */}
          <button
            onClick={() => {
              setOpen(false);
              openSettings("accounts");
            }}
            className="flex w-full items-center gap-2 border-t border-black/10 px-3.5 py-2.5 text-left hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            <span className="text-[11px] font-semibold tracking-wider text-neutral-400">PR ACCOUNT</span>
            <span className="ml-auto truncate text-[12px] text-neutral-600 dark:text-neutral-300">
              {account ? `@${account.username}` : "None"}
            </span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5 text-neutral-300 dark:text-neutral-600">
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              openSettings("repo");
            }}
            className="flex w-full items-center gap-2 border-t border-black/10 px-3.5 py-2.5 text-left text-[12px] text-neutral-600 hover:bg-black/5 hover:text-neutral-800 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-neutral-100"
          >
            <DefaultIdentityIcon className="h-3.5 w-3.5" /> Identity settings…
          </button>
        </div>
      )}
    </div>
  );
}

function Row({
  selected,
  onClick,
  avatar,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-black/5 dark:hover:bg-white/5",
        selected && "bg-[var(--accent-soft)]",
      )}
    >
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-semibold text-neutral-800 dark:text-neutral-100">{title}</div>
        <div className="truncate text-[11px] text-neutral-400">{subtitle}</div>
      </div>
      {selected && <CheckIcon className="h-3.5 w-3.5 flex-none text-[color:var(--accent)]" />}
    </button>
  );
}
