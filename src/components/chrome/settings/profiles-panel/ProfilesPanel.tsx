// Settings → Profiles. The global library of git profiles (Tier 1): create,
// edit, and delete the reusable commit identities here — no repo required.
// Which profile a repository commits as is a per-repo *pick* (Repository
// settings → Identity, or the title-bar identity chip); this panel owns the
// library, not the binding. One deliberate exception: saving an edit to the
// profile the open repo currently has applied re-applies it, so the repo's
// local git config never drifts from the edited profile.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { appliedProfileId, useProfiles } from "../../../../store/profiles";
import { selectProfile, type ProfileDraft } from "../../../../lib/profiles";
import { useUi } from "../../../../store/ui";
import { ProfileEditor } from "./ProfileEditor";
import { ProfileRow } from "./ProfileRow";
import { DefaultIdentityRow } from "./DefaultIdentityRow";

type Editing = { kind: "new"; prefill?: ProfileEditorPrefill } | { kind: "edit"; id: string } | null;
type ProfileEditorPrefill = NonNullable<Parameters<typeof ProfileEditor>[0]["prefill"]>;

export function ProfilesPanel() {
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const profiles = useProfiles((s) => s.profiles);
  const defaultIdentity = useProfiles((s) => s.defaultIdentity);
  const loadDefaultIdentity = useProfiles((s) => s.loadDefaultIdentity);
  const loadProfiles = useProfiles((s) => s.loadProfiles);
  const saveProfile = useProfiles((s) => s.saveProfile);
  const setDefaultProfile = useProfiles((s) => s.setDefaultProfile);
  const deleteProfile = useProfiles((s) => s.deleteProfile);
  const applyProfile = useProfiles((s) => s.applyProfile);
  const intent = useUi((s) => s.profilesIntent);
  const clearProfilesIntent = useUi((s) => s.clearProfilesIntent);
  const [editing, setEditing] = useState<Editing>(null);

  useEffect(() => {
    loadProfiles();
    void loadDefaultIdentity();
  }, [loadProfiles, loadDefaultIdentity]);

  // A repo-scoped surface (repo Identity panel, identity chip) handed off a
  // create/edit request. Consume it exactly once.
  useEffect(() => {
    if (!intent) return;
    setEditing(intent);
    clearProfilesIntent();
  }, [intent, clearProfilesIntent]);

  const handleSave = (draft: ProfileDraft) => {
    const path = summary?.path ?? null;
    const selection = path ? selectProfile(repoIdentity, profiles, appliedProfileId(path)) : null;
    // Keep the open repo's git config in sync when its applied profile changes,
    // and pin an adopted unmanaged identity (create-with-prefill) to its repo.
    const wasAppliedEdit =
      editing?.kind === "edit" && selection?.kind === "profile" && selection.id === editing.id;
    const wasAdoption = editing?.kind === "new" && Boolean(editing.prefill);
    const saved = saveProfile(draft);
    setEditing(null);
    if (wasAppliedEdit || wasAdoption) void applyProfile(saved.id);
  };

  return (
    <>
      {/* HEADER */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Profiles</h2>
          <p className="mt-1.5 max-w-[480px] text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty">
            Reusable commit identities — who your commits are{" "}
            <span className="font-semibold text-neutral-800 dark:text-neutral-100">authored and signed as</span>. Each
            repository picks its profile in Repository settings or the title-bar identity chip.
          </p>
        </div>
        {editing?.kind !== "new" && profiles.length > 0 && (
          <button
            onClick={() => setEditing({ kind: "new" })}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 text-[13px] font-semibold text-white transition hover:brightness-110",
              focusRing,
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New profile
          </button>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {/* The global git-config identity: part of the library picture (repos
            with no profile pinned commit as this), but managed by git itself. */}
        <DefaultIdentityRow identity={defaultIdentity} />

        {profiles.map((p) =>
          editing?.kind === "edit" && editing.id === p.id ? (
            <ProfileEditor
              key={p.id}
              profile={p}
              onSave={handleSave}
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
            <ProfileRow key={p.id} profile={p} onEdit={() => setEditing({ kind: "edit", id: p.id })} />
          ),
        )}

        {editing?.kind === "new" && (
          <ProfileEditor profile={null} prefill={editing.prefill} onSave={handleSave} onCancel={() => setEditing(null)} />
        )}

        {profiles.length === 0 && editing?.kind !== "new" && <EmptyState onAdd={() => setEditing({ kind: "new" })} />}
      </div>
    </>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-black/15 bg-black/[0.015] p-6 text-center dark:border-white/[0.14] dark:bg-white/[0.02]">
      <div className="mx-auto grid h-11 w-11 place-items-center rounded-[13px] bg-black/[0.05] text-neutral-400 dark:bg-white/[0.07] dark:text-neutral-500">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
      </div>
      <div className="mt-3 text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">No profiles yet</div>
      <p className="mx-auto mt-1.5 max-w-[360px] text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400 text-pretty">
        A profile is all a repository needs to commit, fetch &amp; push — no account required. Save one here, then pick
        it per repo.
      </p>
      <button
        onClick={onAdd}
        className={cn(
          "mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 text-[13px] font-semibold text-white transition hover:brightness-110",
          focusRing,
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New profile
      </button>
    </div>
  );
}
