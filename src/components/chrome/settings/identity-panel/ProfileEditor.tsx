// Inline editor for creating or editing a git profile (Zone A). Controlled
// fields; Save is gated on a label, name, and well-formed email. Signing is
// optional — a key id/path plus its format and the commit.gpgsign toggle.

import { useId, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { isValidEmail } from "../identity";
import { profileInitials, type GitProfile, type ProfileDraft } from "../../../../lib/profiles";

const inputCls =
  "w-full h-10 px-3.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.04] text-[13.5px] text-neutral-900 dark:text-white outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]";
const fieldLabelCls =
  "block text-[11px] font-semibold tracking-[0.08em] text-neutral-400 dark:text-neutral-500 mb-1.5";

export function ProfileEditor({
  profile,
  prefill,
  onSave,
  onCancel,
  onSetDefault,
  onDelete,
}: {
  /** The profile being edited, or `null` to create a new one. */
  profile: GitProfile | null;
  /** Seed values for a new profile (e.g. adopting an unmanaged local identity). */
  prefill?: Partial<Pick<GitProfile, "name" | "email" | "signingKey" | "gpgFormat" | "gpgSign">>;
  onSave: (draft: ProfileDraft) => void;
  onCancel: () => void;
  onSetDefault?: () => void;
  onDelete?: () => void;
}) {
  const seed = profile ?? prefill;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [name, setName] = useState(seed?.name ?? "");
  const [email, setEmail] = useState(seed?.email ?? "");
  const [signingKey, setSigningKey] = useState(seed?.signingKey ?? "");
  const [gpgFormat, setGpgFormat] = useState<"openpgp" | "ssh">(seed?.gpgFormat ?? "openpgp");
  const [gpgSign, setGpgSign] = useState(seed?.gpgSign ?? false);
  const labelId = useId();
  const nameId = useId();
  const emailId = useId();
  const keyId = useId();

  const hasKey = signingKey.trim() !== "";
  const valid = label.trim() !== "" && name.trim() !== "" && isValidEmail(email);

  const submit = () => {
    if (!valid) return;
    onSave({
      id: profile?.id,
      label: label.trim(),
      name: name.trim(),
      email: email.trim(),
      signingKey: hasKey ? signingKey.trim() : undefined,
      gpgFormat: hasKey ? gpgFormat : undefined,
      gpgSign: hasKey ? gpgSign : false,
    });
  };

  return (
    <div className="rounded-xl border border-[color:var(--accent)]/40 bg-white dark:bg-neutral-800 shadow-sm p-4">
      <div className="flex items-center gap-3">
        <span
          className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center text-white text-[12px] font-bold"
          style={{ background: profile?.color ?? "var(--accent)" }}
        >
          {profileInitials(label || profile?.label || "New")}
        </span>
        <div className="text-[14px] font-semibold text-neutral-900 dark:text-white">
          {profile ? "Edit profile" : "New profile"}
        </div>
        <button
          onClick={onCancel}
          aria-label="Cancel"
          className={cn(
            "ml-auto w-7 h-7 grid place-items-center rounded-lg text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 transition",
            focusRing,
          )}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-4">
        <label htmlFor={labelId} className={fieldLabelCls}>
          PROFILE NAME
        </label>
        <input
          id={labelId}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Personal, Work…"
          className={inputCls}
        />
      </div>

      <div className="mt-3.5 grid grid-cols-2 gap-3.5">
        <div>
          <label htmlFor={nameId} className={fieldLabelCls}>
            NAME
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your Name"
            className={inputCls}
          />
        </div>
        <div>
          <label htmlFor={emailId} className={fieldLabelCls}>
            EMAIL
          </label>
          <input
            id={emailId}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={cn(inputCls, "font-mono")}
          />
        </div>
      </div>

      <div className="mt-3.5">
        <label htmlFor={keyId} className={fieldLabelCls}>
          SIGNING KEY{" "}
          <span className="font-normal lowercase tracking-normal text-neutral-300 dark:text-neutral-600">
            — GPG key id or SSH key (optional)
          </span>
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <circle cx="7.5" cy="15.5" r="4.5" />
                <path d="m10.6 12.4 8.4-8.4M16 5l3 3M14 7l3 3" />
              </svg>
            </span>
            <input
              id={keyId}
              value={signingKey}
              onChange={(e) => setSigningKey(e.target.value)}
              placeholder="4A9F2C1B7E… or ~/.ssh/id_ed25519.pub"
              className={cn(inputCls, "pl-9 font-mono text-[13px]")}
            />
          </div>
          {hasKey && (
            <div className="flex h-10 shrink-0 items-center rounded-lg border border-black/10 dark:border-white/10 p-0.5">
              {(["openpgp", "ssh"] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => setGpgFormat(fmt)}
                  className={cn(
                    "h-full px-2.5 rounded-[7px] text-[12px] font-semibold transition",
                    gpgFormat === fmt
                      ? "bg-[var(--accent)] text-white"
                      : "text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10",
                    focusRing,
                  )}
                >
                  {fmt === "openpgp" ? "GPG" : "SSH"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3.5 flex items-center gap-3 p-3 rounded-lg bg-black/[0.03] dark:bg-white/[0.04] border border-black/[0.06] dark:border-white/[0.07]">
        <button
          role="switch"
          aria-checked={gpgSign}
          aria-label="Sign commits"
          disabled={!hasKey}
          onClick={() => setGpgSign((v) => !v)}
          className={cn(
            "shrink-0 w-9 h-5 rounded-full p-0.5 flex transition-colors",
            gpgSign ? "bg-[var(--accent)] justify-end" : "bg-black/15 dark:bg-white/20 justify-start",
            !hasKey && "opacity-40 cursor-not-allowed",
            focusRing,
          )}
        >
          <span className="w-4 h-4 rounded-full bg-white shadow-sm" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
            Sign commits <span className="font-mono text-[11.5px] text-neutral-400 dark:text-neutral-500">commit.gpgsign</span>
          </div>
          <div className="text-[11.5px] text-neutral-500 dark:text-neutral-400">
            Signing fields write to local git config so signed commits keep working.
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          disabled={!valid}
          onClick={submit}
          className={cn(
            "h-9 px-4 rounded-lg text-[13px] font-semibold text-white shadow-sm transition",
            valid ? "bg-[var(--accent)] hover:brightness-110 active:scale-[0.97]" : "bg-black/[0.12] dark:bg-white/[0.12] cursor-not-allowed",
            focusRing,
          )}
        >
          Save profile
        </button>
        <button
          onClick={onCancel}
          className={cn(
            "h-9 px-3.5 rounded-lg text-[13px] font-semibold text-neutral-600 dark:text-neutral-300 border border-black/10 dark:border-white/[0.12] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition",
            focusRing,
          )}
        >
          Cancel
        </button>
        <div className="ml-auto flex items-center gap-1">
          {onSetDefault && (
            <button
              onClick={onSetDefault}
              className={cn(
                "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12.5px] font-semibold text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition",
                focusRing,
              )}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.3l6.5-.9z" />
              </svg>
              Set as default
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className={cn(
                "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[12.5px] font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 transition",
                focusRing,
              )}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
