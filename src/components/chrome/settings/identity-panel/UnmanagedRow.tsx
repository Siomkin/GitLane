// Shown when the repo's local git config pins an identity that matches no saved
// profile (e.g. set outside GitLane, or before profiles existed). Instead of an
// empty panel with nothing selected, surface it with a path forward: adopt it as
// a profile, or drop it for the default git identity.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import type { RepoIdentity } from "../../../../store/accounts";

export function UnmanagedRow({
  identity,
  onSaveAsProfile,
  onUseDefault,
}: {
  identity: RepoIdentity;
  onSaveAsProfile: () => void;
  onUseDefault: () => void;
}) {
  const signed = Boolean(identity.signingKey);
  return (
    <div className="rounded-xl border border-[color:var(--accent)]/40 bg-[var(--accent-soft)] p-3">
      <div className="flex items-center gap-3">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-neutral-500 dark:bg-white/[0.1] dark:text-neutral-300">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21a8 8 0 0 1 16 0" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">Unmanaged local identity</span>
            {signed && (
              <span className="inline-flex h-[17px] items-center gap-1 rounded-full bg-black/[0.05] px-1.5 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                signed
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-neutral-600 dark:text-neutral-300">
            {identity.name} · <span className="font-mono text-[11.5px]">{identity.email}</span>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onSaveAsProfile}
          className={cn(
            "h-8 rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-white transition hover:brightness-110",
            focusRing,
          )}
        >
          Save as profile
        </button>
        <button
          onClick={onUseDefault}
          className={cn(
            "h-8 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
            focusRing,
          )}
        >
          Clear &amp; use default
        </button>
      </div>
    </div>
  );
}
