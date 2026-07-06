// One saved profile in the global Profiles library list. Read-only summary
// (avatar, label, badges, name · email) with an Edit action — unlike the repo
// Identity panel's rows, these are not selectable: applying a profile is a
// per-repo decision made elsewhere.

import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { profileInitials, type GitProfile } from "../../../../lib/profiles";

export function ProfileRow({ profile, onEdit }: { profile: GitProfile; onEdit: () => void }) {
  const signLabel = profile.gpgFormat === "ssh" ? "SSH signed" : "GPG signed";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <span
        className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] text-[12px] font-bold text-white"
        style={{ background: profile.color }}
      >
        {profileInitials(profile.label)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">{profile.label}</span>
          {profile.isDefault && (
            <span
              className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400"
              title="Your suggested profile — offered first for repos with nothing pinned"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-3 w-3">
                <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.3l6.5-.9z" />
              </svg>
              Suggested
            </span>
          )}
          {profile.signingKey && (
            <span
              className="inline-flex h-[17px] items-center gap-1 rounded-full bg-black/[0.05] px-1.5 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-400"
              title="Signing key set"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              {signLabel}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
          {profile.name} · {profile.email}
        </div>
      </div>
      <button
        onClick={onEdit}
        aria-label={`Edit ${profile.label}`}
        className={cn(
          "h-8 shrink-0 rounded-lg px-2.5 text-[12px] font-medium text-neutral-500 transition hover:bg-black/[0.06] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200",
          focusRing,
        )}
      >
        Edit
      </button>
    </div>
  );
}
