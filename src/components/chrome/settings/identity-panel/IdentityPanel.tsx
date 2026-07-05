// Repository settings → the commit profile section (GL-130): pick who this
// repo commits as — this computer or a saved git profile. Network auth lives
// in the remote-access section; this panel only writes author/signing config.

import { useEffect } from "react";
import { useRepo } from "../../../../store/repo";
import { useIdentities } from "../../../../store/identities";
import { CommitAsZone } from "./CommitAsZone";

export function IdentityPanel() {
  const summary = useRepo((s) => s.summary);
  const loadIdentities = useIdentities((s) => s.loadIdentities);
  const loadDefaultIdentity = useIdentities((s) => s.loadDefaultIdentity);

  useEffect(() => {
    loadIdentities();
    void loadDefaultIdentity();
  }, [loadIdentities, loadDefaultIdentity]);

  if (!summary) {
    return (
      <div className="max-w-[760px]">
        <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identity</h2>
        <div className="mt-4 rounded-xl border border-black/10 bg-black/[0.03] p-5 text-[13px] text-neutral-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-400">
          Open a repository to choose the identity it commits as.
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-[760px]">
      {/* HEADER */}
      <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identity</h2>
      <p className="mt-1.5 text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty max-w-[480px]">
        Who this repo <span className="font-semibold text-neutral-800 dark:text-neutral-100">commits as</span> — pick
        the computer default or one of your saved git profiles.
      </p>

      <CommitAsZone />
    </div>
  );
}
