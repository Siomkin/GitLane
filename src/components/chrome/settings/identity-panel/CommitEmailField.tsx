// Per-repo commit email for the applied profile. This is where a user *creates*
// the override (not just resets it): editing the email calls
// useProfiles.setCustomEmail, which persists it per repo+profile so it survives
// switching profiles away and back (the GL-27 guarantee). Rendered as one
// compact line under the commit-as card — the zones above/below stay close —
// expanding into an inline input (with the override explainer) only while
// editing. A "custom" badge + Reset appear when the email diverges.

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

  if (editing) {
    return (
      <div className="mt-2 rounded-lg border border-black/[0.07] bg-black/[0.02] p-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[12px] text-neutral-500 dark:text-neutral-400">Commit email</span>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="you@example.com"
            className="h-8 min-w-0 flex-1 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-900 outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)] dark:border-white/10 dark:bg-neutral-800 dark:text-white"
          />
          <button
            disabled={!valid || !dirty}
            onClick={() => {
              onSave(value.trim());
              setEditing(false);
            }}
            className={cn(
              "h-8 shrink-0 rounded-lg px-3 text-[12px] font-semibold text-white transition",
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
              "h-8 shrink-0 rounded-lg border border-black/10 px-2.5 text-[12px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
              focusRing,
            )}
          >
            Cancel
          </button>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400 text-pretty">
          Overrides {profileLabel}’s <span className="font-mono text-[11px]">{profileEmail}</span> for this repo only.
          Switching profiles or accounts never rewrites it — only Reset to default does.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2 px-1 text-[12px] text-neutral-500 dark:text-neutral-400">
      <span className="shrink-0">Commit email:</span>
      <span
        className="truncate font-mono text-[12px] text-neutral-600 dark:text-neutral-300"
        title={custom ? `Overrides ${profileLabel}’s ${profileEmail} for this repo only` : undefined}
      >
        {currentEmail}
      </span>
      {custom && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--accent)]">
          custom
        </span>
      )}
      <button
        onClick={() => setEditing(true)}
        aria-label="Edit commit email"
        className={cn(
          "shrink-0 font-medium text-[color:var(--accent)] hover:underline",
          focusRing,
        )}
      >
        Edit
      </button>
      {custom && (
        <button
          onClick={onReset}
          className={cn("shrink-0 font-medium text-neutral-400 hover:text-neutral-600 hover:underline dark:text-neutral-500 dark:hover:text-neutral-300", focusRing)}
        >
          Reset to default
        </button>
      )}
    </div>
  );
}
