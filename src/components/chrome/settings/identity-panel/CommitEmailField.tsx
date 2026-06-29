// Per-repo commit email for the applied profile. This is where a user *creates*
// the override (not just resets it): editing the email calls
// useProfiles.setCustomEmail, which persists it per repo+profile so it survives
// switching profiles away and back (the GL-27 guarantee). When the email
// diverges from the profile default, a "custom" badge + Reset-to-default appear.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { isValidEmail } from "../identity";

export function CommitEmailField({
  profileLabel,
  profileEmail,
  currentEmail,
  custom,
  onSave,
  onReset,
}: {
  profileLabel: string;
  profileEmail: string;
  currentEmail: string;
  custom: boolean;
  onSave: (email: string) => void;
  onReset: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentEmail);

  useEffect(() => {
    if (!editing) setValue(currentEmail);
  }, [currentEmail, editing]);

  const valid = isValidEmail(value);
  const dirty = value.trim() !== currentEmail;

  return (
    <div className="mt-4 rounded-xl border border-black/[0.07] bg-black/[0.02] p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            COMMIT EMAIL FOR THIS REPO
          </span>
          {custom && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold text-[color:var(--accent)]">
              custom
            </span>
          )}
        </div>
        {custom && !editing && (
          <button
            onClick={onReset}
            className={cn("inline-flex items-center gap-1 text-[11.5px] font-semibold text-[color:var(--accent)] hover:underline", focusRing)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
            Reset to default
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="you@example.com"
            className="h-9 flex-1 rounded-lg border border-black/10 bg-white px-3 font-mono text-[13px] text-neutral-900 outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] dark:border-white/10 dark:bg-neutral-800 dark:text-white"
          />
          <button
            disabled={!valid || !dirty}
            onClick={() => {
              onSave(value.trim());
              setEditing(false);
            }}
            className={cn(
              "h-9 rounded-lg px-3.5 text-[12.5px] font-semibold text-white transition",
              valid && dirty ? "bg-[var(--accent)] hover:brightness-110" : "cursor-not-allowed bg-black/[0.12] dark:bg-white/[0.12]",
              focusRing,
            )}
          >
            Save
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setValue(currentEmail);
            }}
            className={cn(
              "h-9 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
              focusRing,
            )}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="truncate font-mono text-[13px] text-neutral-700 dark:text-neutral-200">{currentEmail}</span>
          <button
            onClick={() => setEditing(true)}
            aria-label="Edit commit email"
            className={cn(
              "shrink-0 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-neutral-500 transition hover:bg-black/[0.06] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
            </svg>
            Edit
          </button>
        </div>
      )}

      <p className="mt-2.5 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400 text-pretty">
        Overrides {profileLabel}’s <span className="font-mono text-[11.5px]">{profileEmail}</span> for this repo only.
        Switching profiles or accounts never rewrites it — only Reset to default does.
      </p>
    </div>
  );
}
