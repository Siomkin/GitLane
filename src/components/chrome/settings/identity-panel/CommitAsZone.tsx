// Zone A — who this repo commits as. State-first like the PR-account zone: the
// collapsed view is one card with the current pick (default git identity, a
// saved profile, or an unmanaged local identity), so both zones fit one screen
// regardless of how many profiles exist; "Change" expands the radio picker.
// Profile create/edit hands off to the global Settings → Profiles panel.

import { useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { appliedProfileId, useProfiles } from "../../../../store/profiles";
import { profileInitials, selectProfile, type GitProfile } from "../../../../lib/profiles";
import { useUi, type ProfilesIntent } from "../../../../store/ui";
import { GitBranchIcon } from "../../../ui/icons";
import { RadioCard } from "./RadioCard";
import { CommitEmailField } from "./CommitEmailField";
import { UnmanagedRow } from "./UnmanagedRow";

export function CommitAsZone() {
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const profiles = useProfiles((s) => s.profiles);
  const defaultIdentity = useProfiles((s) => s.defaultIdentity);
  const applyProfile = useProfiles((s) => s.applyProfile);
  const setCustomEmail = useProfiles((s) => s.setCustomEmail);
  const resetCustomEmail = useProfiles((s) => s.resetCustomEmail);
  const closeRepoSettings = useUi((s) => s.closeRepoSettings);
  const openProfilesSettings = useUi((s) => s.openProfilesSettings);
  const [picking, setPicking] = useState(false);

  // Profile create/edit lives in the global Profiles panel — hand off to it.
  const editInProfiles = (intent: ProfilesIntent) => {
    closeRepoSettings();
    openProfilesSettings(intent);
  };

  if (!summary) return null;

  const selection = selectProfile(repoIdentity, profiles, appliedProfileId(summary.path));
  const selectedProfile =
    selection.kind === "profile" ? profiles.find((p) => p.id === selection.id) ?? null : null;
  const customEmail = selection.kind === "profile" && selection.customEmail;

  const pick = (id: string | null, alreadySelected: boolean) => {
    // Re-picking the current row is just "close" — don't rewrite git config.
    if (!alreadySelected) void applyProfile(id);
    setPicking(false);
  };

  const defaultSubtitle = defaultIdentity
    ? `${defaultIdentity.name} · ${defaultIdentity.email}`
    : "No identity set in global git config";
  const defaultBadge = (
    <span className="px-1.5 h-[17px] grid place-items-center rounded text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400 bg-black/[0.05] dark:bg-white/[0.07]">
      Global config
    </span>
  );

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px] font-semibold tracking-[0.08em] text-neutral-500 dark:text-neutral-400">
          COMMIT AS · GIT PROFILE
        </div>
        <button
          onClick={() => editInProfiles({ kind: "new" })}
          className={cn(
            "text-[11.5px] font-semibold text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300",
            focusRing,
          )}
        >
          Manage profiles ↗
        </button>
      </div>
      <p className="mt-1.5 text-[12.5px] text-neutral-500 dark:text-neutral-400">
        The identity written to this repo's local git config — who shows up in{" "}
        <span className="font-mono text-[12px]">git log</span>.
      </p>

      {picking ? (
        <div className="mt-3 rounded-xl border border-black/[0.08] bg-black/[0.015] p-2 dark:border-white/[0.1] dark:bg-white/[0.02]">
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Commit as">
            <RadioCard
              selected={selection.kind === "default"}
              onSelect={() => pick(null, selection.kind === "default")}
              label="Default git identity"
              avatar={<DefaultAvatar />}
              title="Default git identity"
              badges={defaultBadge}
              subtitle={defaultSubtitle}
            />
            {profiles.map((p) => (
              <ProfileOptionRow
                key={p.id}
                profile={p}
                selected={selection.kind === "profile" && selection.id === p.id}
                custom={customEmail && selectedProfile?.id === p.id}
                customSigning={
                  selection.kind === "profile" && selection.id === p.id && selection.customSigning
                }
                customEmailValue={repoIdentity?.email}
                onSelect={() => pick(p.id, selection.kind === "profile" && selection.id === p.id)}
                onEdit={() => editInProfiles({ kind: "edit", id: p.id })}
              />
            ))}
          </div>
          <button
            onClick={() => editInProfiles({ kind: "new" })}
            className={cn(
              "mt-1.5 flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium text-[color:var(--accent)] hover:bg-[var(--accent-soft)]",
              focusRing,
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New profile
          </button>
        </div>
      ) : selection.kind === "unmanaged" && repoIdentity ? (
        // An identity pinned outside GitLane: surface it with its own actions
        // (adopt / clear) — plus Change to pick something else outright.
        <div className="mt-3">
          <UnmanagedRow
            identity={repoIdentity}
            onSaveAsProfile={() =>
              editInProfiles({
                kind: "new",
                prefill: {
                  name: repoIdentity.name,
                  email: repoIdentity.email,
                  signingKey: repoIdentity.signingKey,
                  gpgFormat: repoIdentity.gpgFormat === "ssh" ? "ssh" : repoIdentity.gpgFormat === "openpgp" ? "openpgp" : undefined,
                  gpgSign: repoIdentity.gpgSign,
                  tagGpgSign: repoIdentity.tagGpgSign,
                },
              })
            }
            onUseDefault={() => void applyProfile(null)}
          />
          <button
            onClick={() => setPicking(true)}
            className={cn(
              "mt-2 text-[12px] font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Choose a different identity…
          </button>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 p-3 rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03]">
          {selectedProfile ? (
            <span
              className="w-9 h-9 shrink-0 rounded-[10px] grid place-items-center text-white text-[11px] font-bold"
              style={{ background: selectedProfile.color }}
            >
              {profileInitials(selectedProfile.label)}
            </span>
          ) : (
            <DefaultAvatar size={9} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-neutral-900 dark:text-white">
                {selectedProfile ? selectedProfile.label : "Default git identity"}
              </span>
              {selectedProfile ? <ProfileBadges profile={selectedProfile} custom={customEmail} customSigning={selection.kind === "profile" && selection.customSigning} /> : defaultBadge}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
              {selectedProfile
                ? `${selectedProfile.name} · ${customEmail ? repoIdentity?.email ?? selectedProfile.email : selectedProfile.email}`
                : defaultSubtitle}
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
      )}

      {selection.kind === "profile" && selectedProfile && !picking && (
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
  );
}

function DefaultAvatar({ size = 9.5 }: { size?: number }) {
  const px = size === 9 ? "h-9 w-9" : "h-[38px] w-[38px]";
  return (
    <span className={cn(px, "shrink-0 rounded-[10px] grid place-items-center bg-black/[0.06] dark:bg-white/[0.08] text-neutral-500 dark:text-neutral-300")}>
      <GitBranchIcon className="w-[18px] h-[18px]" />
    </span>
  );
}

function ProfileBadges({
  profile,
  custom,
  customSigning,
}: {
  profile: GitProfile;
  custom: boolean;
  customSigning: boolean;
}) {
  const signLabel = profile.gpgFormat === "ssh" ? "SSH signed" : "GPG signed";
  return (
    <>
      {profile.isDefault && (
        <span
          className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-600 dark:text-amber-400"
          title="Your suggested profile — pick it to apply (not auto-applied yet)"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
            <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.3l6.5-.9z" />
          </svg>
          Suggested
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
  );
}

function ProfileOptionRow({
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
      badges={<ProfileBadges profile={profile} custom={custom} customSigning={customSigning} />}
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
          title="Edit this profile in Settings → Profiles"
          className="shrink-0 text-[12px] font-medium px-2.5 h-8 rounded-lg text-neutral-500 dark:text-neutral-400 hover:bg-black/[0.06] dark:hover:bg-white/10 hover:text-neutral-700 dark:hover:text-neutral-200 transition"
        >
          Edit ↗
        </button>
      }
    />
  );
}
