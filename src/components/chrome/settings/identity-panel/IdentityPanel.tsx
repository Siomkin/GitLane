// Repository settings → Identity. The per-repo *binding* layer of the two-tier
// identity model: pick who this repo commits as (CommitAsZone — a git profile,
// or the default git identity) and who it opens pull requests as (PrAccountZone
// — an optional provider account). Both zones are state-first: a compact
// current-pick card with a Change picker, so the two answers are visible
// together on one screen. The libraries themselves are global: profiles are
// managed in Settings → Profiles, accounts in Settings → Accounts; creating or
// editing from here hands off to those panels. The only mutation owned here
// besides the picks is the per-repo custom commit email.

import { useEffect } from "react";
import { useRepo } from "../../../../store/repo";
import { useProfiles } from "../../../../store/profiles";
import { CommitAsZone } from "./CommitAsZone";
import { PrAccountZone } from "./PrAccountZone";

export function IdentityPanel() {
  const summary = useRepo((s) => s.summary);
  const loadProfiles = useProfiles((s) => s.loadProfiles);
  const loadDefaultIdentity = useProfiles((s) => s.loadDefaultIdentity);

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

  return (
    <>
      {/* HEADER */}
      <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identity</h2>
      <p className="mt-1.5 text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty max-w-[480px]">
        Pick who this repo <span className="font-semibold text-neutral-800 dark:text-neutral-100">commits as</span> (a
        git profile) and, optionally, who it{" "}
        <span className="font-semibold text-neutral-800 dark:text-neutral-100">opens pull requests as</span> (an
        account). Both are managed globally in App settings — here you only choose.
      </p>

      <CommitAsZone />
      <PrAccountZone />
    </>
  );
}
