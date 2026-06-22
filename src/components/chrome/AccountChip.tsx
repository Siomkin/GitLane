// Title-bar identity chip: shows the account the current repo commits/fetches
// as, and opens a popover to switch it (or jump to account management). The
// per-repo binding lives in the accounts store.

import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { useDismiss } from "../../hooks/useDismiss";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { useAccounts } from "../../store/accounts";
import { CheckIcon, GitHubIcon } from "../ui/icons";
import { repoLabel } from "../../lib/paths";

export function AccountChip() {
  const summary = useRepo((s) => s.summary);
  const accounts = useAccounts((s) => s.accounts);
  const repoAccountId = useAccounts((s) => s.repoAccountId);
  const setRepoAccount = useAccounts((s) => s.setRepoAccount);
  const openSettings = useUi((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), ref);

  if (!summary) return null;

  const bound = accounts.find((a) => a.id === repoAccountId) ?? null;

  const pick = (id: string | null) => {
    void setRepoAccount(id);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Identity for this repository"
        className="flex items-center gap-1.5 h-8 pl-1 pr-2.5 rounded-full hover:bg-black/5 dark:hover:bg-white/5"
      >
        {bound ? (
          <span
            className="grid w-6 h-6 place-items-center rounded-full text-[10px] font-semibold text-white"
            style={{ background: bound.color }}
          >
            {bound.username.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          <span className="grid w-6 h-6 place-items-center rounded-full bg-black/[0.05] dark:bg-white/[0.06] text-[10px] font-semibold text-neutral-400">
            —
          </span>
        )}
        <span className="max-w-[120px] truncate text-[13px] font-medium text-neutral-700 dark:text-neutral-200">
          {bound ? `@${bound.username}` : "Set identity"}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-[34px] z-[70] w-[280px] overflow-hidden rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-neutral-800 shadow-[0_18px_44px_-8px_rgba(0,0,0,0.42)]">
          <div className="border-b border-black/10 dark:border-white/10 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold tracking-wider text-neutral-400">
              IDENTITY FOR THIS REPOSITORY
            </div>
            <div className="mt-0.5 truncate text-[12px] text-neutral-600 dark:text-neutral-300">
              {repoLabel(summary.workdir ?? summary.path)}
            </div>
          </div>

          <div className="max-h-[260px] overflow-auto py-1">
            <Row
              selected={repoAccountId === null}
              onClick={() => pick(null)}
              avatar={
                <span className="grid h-[26px] w-[26px] place-items-center rounded-md bg-black/[0.05] dark:bg-white/[0.06] text-[11px] text-neutral-400">
                  —
                </span>
              }
              title="No identity (read-only)"
              subtitle="Use the repo / global git config"
            />
            {accounts.map((a) => (
              <Row
                key={a.id}
                selected={repoAccountId === a.id}
                onClick={() => pick(a.id)}
                avatar={
                  <span
                    className="grid h-[26px] w-[26px] place-items-center rounded-md text-[11px] font-bold text-white"
                    style={{ background: a.color }}
                  >
                    {a.username.slice(0, 2).toUpperCase()}
                  </span>
                }
                title={`@${a.username}`}
                subtitle={`${a.name} · ${a.host}`}
              />
            ))}
            {accounts.length === 0 && (
              <div className="px-3.5 py-3 text-[11.5px] leading-relaxed text-neutral-400">
                No GitHub accounts found. Run <span className="font-mono">gh auth login</span>, then
                Refresh in Settings.
              </div>
            )}
          </div>

          <button
            onClick={() => {
              setOpen(false);
              openSettings("accounts");
            }}
            className="flex w-full items-center gap-2 border-t border-black/10 dark:border-white/10 px-3.5 py-2.5 text-left text-[12px] text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5 hover:text-neutral-800 dark:hover:text-neutral-100"
          >
            <GitHubIcon className="h-3.5 w-3.5" /> Manage accounts…
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
