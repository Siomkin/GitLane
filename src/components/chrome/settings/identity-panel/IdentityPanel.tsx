// Settings → Identity. Tier 1 of GitLane's identity model: a reusable git
// profile (name + email + optional signing) is all you need to commit, fetch &
// push — no provider account required. Zone A owns profiles + the default git
// identity; Zone B is the optional pull-request account. Faithful port of the
// "Settings — Identity & Accounts" design (IdentityPanel component).

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { useProfiles } from "../../../../store/profiles";
import { profileInitials, selectProfile, type GitProfile } from "../../../../lib/profiles";
import { RadioCard } from "./RadioCard";
import { ProfileEditor } from "./ProfileEditor";
import { CommitEmailField } from "./CommitEmailField";
import { UnmanagedRow } from "./UnmanagedRow";
import { PrAccountZone } from "./PrAccountZone";

type Prefill = Partial<Pick<GitProfile, "name" | "email" | "signingKey" | "gpgFormat" | "gpgSign">>;
type Editing = { kind: "new"; prefill?: Prefill } | { kind: "edit"; id: string } | null;

export function IdentityPanel() {
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const profiles = useProfiles((s) => s.profiles);
  const defaultIdentity = useProfiles((s) => s.defaultIdentity);
  const loadProfiles = useProfiles((s) => s.loadProfiles);
  const loadDefaultIdentity = useProfiles((s) => s.loadDefaultIdentity);
  const applyProfile = useProfiles((s) => s.applyProfile);
  const saveProfile = useProfiles((s) => s.saveProfile);
  const setDefaultProfile = useProfiles((s) => s.setDefaultProfile);
  const deleteProfile = useProfiles((s) => s.deleteProfile);
  const setCustomEmail = useProfiles((s) => s.setCustomEmail);
  const resetCustomEmail = useProfiles((s) => s.resetCustomEmail);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    loadProfiles();
    void loadDefaultIdentity();
  }, [loadProfiles, loadDefaultIdentity]);

  if (!summary) {
    return (
      <>
        <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identity</h2>
        <div className="mt-4 rounded-xl border border-black/10 bg-black/[0.03] p-5 text-[13px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400">
          Open a repository to choose the git profile it commits, fetches, and pushes as.
        </div>
      </>
    );
  }

  const selection = selectProfile(repoIdentity, profiles);
  const selectedProfile =
    selection.kind === "profile" ? profiles.find((p) => p.id === selection.id) ?? null : null;
  const customEmail = selection.kind === "profile" && selection.customEmail;

  const onSave = (id: string | undefined) => (draft: Parameters<typeof saveProfile>[0]) => {
    saveProfile(draft);
    setEditing(null);
    // Keep local git config in sync if the edited profile is the applied one.
    if (id && selection.kind === "profile" && selection.id === id) void applyProfile(id);
  };

  return (
    <>
      {/* HEADER */}
      <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identity</h2>
      <p className="mt-1.5 text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty max-w-[480px]">
        A <span className="font-semibold text-neutral-800 dark:text-neutral-100">git profile</span> is all you need to
        commit, fetch &amp; push. Accounts are optional — they add pull requests.
      </p>

      {/* ZONE A — COMMIT IDENTITY / GIT PROFILE */}
      <div className="mt-7">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[11px] font-semibold tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
            COMMIT IDENTITY · GIT PROFILE
          </div>
          <div className="text-[11.5px] text-neutral-400 dark:text-neutral-500">
            Who shows up in <span className="font-mono text-[11px]">git log</span>
          </div>
        </div>
        <p className="mt-1.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
          Pick a saved profile to apply to this repo — it writes{" "}
          <span className="font-mono text-[12px] text-neutral-600 dark:text-neutral-300">user.name</span> /{" "}
          <span className="font-mono text-[12px] text-neutral-600 dark:text-neutral-300">user.email</span> to local git
          config.
        </p>

        <div className="mt-3.5 flex flex-col gap-2" role="radiogroup" aria-label="Commit identity">
          {/* Default git identity */}
          <RadioCard
            selected={selection.kind === "default"}
            onSelect={() => void applyProfile(null)}
            label="Default git identity"
            avatar={
              <span className="w-[38px] h-[38px] shrink-0 rounded-[11px] grid place-items-center bg-black/[0.06] dark:bg-white/[0.08] text-neutral-500 dark:text-neutral-300">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                  <circle cx="6" cy="6" r="2.4" />
                  <circle cx="6" cy="18" r="2.4" />
                  <circle cx="18" cy="12" r="2.4" />
                  <path d="M6 8.4v7.2" />
                  <path d="M18 9.6c0 4-6 1.6-6 6" />
                </svg>
              </span>
            }
            title="Default git identity"
            badges={
              <span className="px-1.5 h-[17px] grid place-items-center rounded text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 bg-black/[0.05] dark:bg-white/[0.07]">
                Global config
              </span>
            }
            subtitle={
              defaultIdentity
                ? `${defaultIdentity.name} · ${defaultIdentity.email}`
                : "No identity set in global git config"
            }
          />

          {/* Saved profiles */}
          {profiles.map((p) =>
            editing?.kind === "edit" && editing.id === p.id ? (
              <ProfileEditor
                key={p.id}
                profile={p}
                onSave={onSave(p.id)}
                onCancel={() => setEditing(null)}
                onSetDefault={() => {
                  setDefaultProfile(p.id);
                  setEditing(null);
                }}
                onDelete={() => {
                  deleteProfile(p.id);
                  setEditing(null);
                }}
              />
            ) : (
              <ProfileRowView
                key={p.id}
                profile={p}
                selected={selection.kind === "profile" && selection.id === p.id}
                custom={customEmail && selectedProfile?.id === p.id}
                customSigning={
                  selection.kind === "profile" && selection.id === p.id && selection.customSigning
                }
                customEmailValue={repoIdentity?.email}
                onSelect={() => void applyProfile(p.id)}
                onEdit={() => setEditing({ kind: "edit", id: p.id })}
              />
            ),
          )}

          {/* Local identity matching no saved profile */}
          {selection.kind === "unmanaged" && repoIdentity && (
            <UnmanagedRow
              identity={repoIdentity}
              onSaveAsProfile={() =>
                setEditing({
                  kind: "new",
                  prefill: {
                    name: repoIdentity.name,
                    email: repoIdentity.email,
                    signingKey: repoIdentity.signingKey,
                    gpgFormat: repoIdentity.gpgFormat === "ssh" ? "ssh" : repoIdentity.gpgFormat === "openpgp" ? "openpgp" : undefined,
                    gpgSign: repoIdentity.gpgSign,
                  },
                })
              }
              onUseDefault={() => void applyProfile(null)}
            />
          )}

          {/* New profile editor */}
          {editing?.kind === "new" && (
            <ProfileEditor
              profile={null}
              prefill={editing.prefill}
              onSave={onSave(undefined)}
              onCancel={() => setEditing(null)}
            />
          )}
        </div>

        {editing?.kind !== "new" && (
          <button
            onClick={() => setEditing({ kind: "new" })}
            className="mt-2 flex items-center gap-2 h-10 px-3 rounded-xl border border-dashed border-black/15 dark:border-white/[0.14] text-[13px] font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:border-black/25 dark:hover:border-white/25 transition w-full justify-center"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New profile
          </button>
        )}

        {selection.kind === "profile" && selectedProfile && (
          <CommitEmailField
            profileLabel={selectedProfile.label}
            profileEmail={selectedProfile.email}
            currentEmail={repoIdentity?.email ?? selectedProfile.email}
            custom={customEmail}
            onSave={(email) => void setCustomEmail(email)}
            onReset={() => void resetCustomEmail()}
          />
        )}
      </div>

      {/* ZONE B — PULL-REQUEST ACCOUNT */}
      <PrAccountZone />
    </>
  );
}

function ProfileRowView({
  profile,
  selected,
  custom,
  customSigning,
  customEmailValue,
  onSelect,
  onEdit,
}: {
  profile: GitProfile;
  selected: boolean;
  custom: boolean;
  customSigning: boolean;
  customEmailValue?: string;
  onSelect: () => void;
  onEdit: () => void;
}) {
  const shownEmail = custom ? customEmailValue ?? profile.email : profile.email;
  const signLabel = profile.gpgFormat === "ssh" ? "SSH signed" : "GPG signed";
  return (
    <RadioCard
      selected={selected}
      onSelect={onSelect}
      label={profile.label}
      avatar={
        <span
          className="w-[38px] h-[38px] shrink-0 rounded-[11px] grid place-items-center text-white text-[12px] font-bold"
          style={{ background: profile.color }}
        >
          {profileInitials(profile.label)}
        </span>
      }
      title={profile.label}
      badges={
        <>
          {profile.isDefault && (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400" title="Default profile for new repos">
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.3l6.5-.9z" />
              </svg>
              Default
            </span>
          )}
          {profile.signingKey && (
            <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-neutral-500 dark:text-neutral-400 bg-black/[0.05] dark:bg-white/[0.08]" title="Signing key set">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                <rect x="5" y="11" width="14" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              {signLabel}
            </span>
          )}
          {custom && (
            <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-[color:var(--accent)] bg-[var(--accent-soft)]">
              custom email
            </span>
          )}
          {customSigning && (
            <span className="inline-flex items-center gap-1 px-1.5 h-[17px] rounded-full text-[10px] font-semibold text-amber-600 dark:text-amber-400 bg-amber-500/12" title="Repo signing config differs from this profile">
              custom signing
            </span>
          )}
        </>
      }
      subtitle={
        <>
          {profile.name} ·{" "}
          <span className={cn(custom && "text-[color:var(--accent)] font-medium")}>{shownEmail}</span>
        </>
      }
      action={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="shrink-0 text-[12px] font-medium px-2.5 h-8 rounded-lg text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-neutral-700 dark:hover:text-neutral-200 transition"
        >
          Edit
        </button>
      }
    />
  );
}
