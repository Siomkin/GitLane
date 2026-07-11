// Settings → Identities → Manual identities. The saved, reusable commit
// identities (name/email + optional signing) that need no provider account —
// what "git profiles" were before GL-130. This section owns the library:
// create, edit, delete. Which identity a repository commits as is a per-repo
// *pick* (Repository settings → Identity, or the title-bar identity chip).
// One deliberate exception: saving an edit to the identity the open repo
// currently has applied re-applies it, so the repo's local git config never
// drifts from the edited identity.

import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useRepo } from "../../../../store/repo";
import { useAccounts } from "../../../../store/accounts";
import { appliedCommitSource, useIdentities } from "../../../../store/identities";
import { selectCommitSource } from "../../../../lib/identities";
import { type ProfileDraft } from "../../../../lib/profiles";
import { useUi } from "../../../../store/ui";
import { ProfileEditor } from "./ProfileEditor";
import { ProfileRow } from "./ProfileRow";

type Editing = { kind: "new"; prefill?: ProfileEditorPrefill } | { kind: "edit"; id: string } | null;
type ProfileEditorPrefill = NonNullable<Parameters<typeof ProfileEditor>[0]["prefill"]>;

export function ManualIdentitiesSection() {
  const summary = useRepo((s) => s.summary);
  const repoIdentity = useAccounts((s) => s.repoIdentity);
  const manuals = useIdentities((s) => s.manualIdentities);
  const defaultIdentity = useIdentities((s) => s.defaultIdentity);
  const saveManualIdentity = useIdentities((s) => s.saveManualIdentity);
  const setDefaultManualIdentity = useIdentities((s) => s.setDefaultManualIdentity);
  const deleteManualIdentity = useIdentities((s) => s.deleteManualIdentity);
  const applyCommitSource = useIdentities((s) => s.applyCommitSource);
  const intent = useUi((s) => s.identitiesIntent);
  const clearIdentitiesIntent = useUi((s) => s.clearIdentitiesIntent);
  const [editing, setEditing] = useState<Editing>(null);

  // A repo-scoped surface (repo Identity panel, identity chip) handed off a
  // create/edit request. Consume it exactly once.
  useEffect(() => {
    if (!intent) return;
    setEditing(intent);
    clearIdentitiesIntent();
  }, [intent, clearIdentitiesIntent]);

  const handleSave = (draft: ProfileDraft) => {
    const selection = summary
      ? selectCommitSource(repoIdentity, manuals, appliedCommitSource(), defaultIdentity)
      : null;
    // Keep the open repo's git config in sync when its applied identity
    // changes, and pin an adopted unmanaged identity (create-with-prefill).
    const wasAppliedEdit =
      editing?.kind === "edit" && selection?.kind === "manual" && selection.id === editing.id;
    const wasAdoption = editing?.kind === "new" && Boolean(editing.prefill);
    const saved = saveManualIdentity(draft);
    setEditing(null);
    if (wasAppliedEdit || wasAdoption) void applyCommitSource({ kind: "manual", id: saved.id });
  };

  return (
    <div className="mt-9">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
            Manual identities
          </div>
          <p className="mt-1.5 max-w-[480px] text-[12.5px] leading-snug text-neutral-500 dark:text-neutral-400 text-pretty">
            Saved name/email (+ optional signing) pairs for commit authorship. Network auth is configured per remote.
          </p>
        </div>
        {editing?.kind !== "new" && manuals.length > 0 && (
          <button type="button"
            onClick={() => setEditing({ kind: "new" })}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-2.5 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
              focusRing,
            )}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New identity
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {manuals.map((p) =>
          editing?.kind === "edit" && editing.id === p.id ? (
            <ProfileEditor
              key={p.id}
              profile={p}
              onSave={handleSave}
              onCancel={() => setEditing(null)}
              onSetDefault={() => {
                setDefaultManualIdentity(p.id);
                setEditing(null);
              }}
              onDelete={() => {
                deleteManualIdentity(p.id);
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

        {manuals.length === 0 && editing?.kind !== "new" && <EmptyState onAdd={() => setEditing({ kind: "new" })} />}
      </div>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-black/15 bg-black/[0.015] p-5 text-center dark:border-white/[0.14] dark:bg-white/[0.02]">
      <div className="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">No manual identities</div>
      <p className="mx-auto mt-1 max-w-[380px] text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400 text-pretty">
        Useful for work, personal, or noreply author addresses. Repos can also use this
        computer's global git config.
      </p>
      <button type="button"
        onClick={onAdd}
        className={cn(
          "mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-600 transition hover:bg-black/[0.04] dark:border-white/[0.12] dark:text-neutral-300 dark:hover:bg-white/[0.06]",
          focusRing,
        )}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New identity
      </button>
    </div>
  );
}
