// Settings → Identities (GL-130, flattened): the saved identity cards — plain
// name + email (+ optional signing) — with the read-only "This computer" row
// on top. Accounts are NOT here: they authenticate (see the Accounts tab) and
// only contribute one-click prefills when creating a card. The container owns
// loading + the page header; the section owns its presentation and store
// wiring.

import { useEffect } from "react";
import { useIdentities } from "../../../../store/identities";
import { ThisComputerRow } from "./ThisComputerRow";
import { ManualIdentitiesSection } from "./ManualIdentitiesSection";

export function IdentitiesPanel() {
  const defaultIdentity = useIdentities((s) => s.defaultIdentity);
  const loadIdentities = useIdentities((s) => s.loadIdentities);
  const loadDefaultIdentity = useIdentities((s) => s.loadDefaultIdentity);

  useEffect(() => {
    loadIdentities();
    void loadDefaultIdentity();
  }, [loadIdentities, loadDefaultIdentity]);

  return (
    <>
      <div>
        <h2 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-white">Identities</h2>
        <p className="mt-1.5 max-w-[520px] text-[13px] leading-snug text-neutral-600 dark:text-neutral-300 text-pretty">
          Who your commits are{" "}
          <span className="font-semibold text-neutral-800 dark:text-neutral-100">authored and signed as</span> — plain
          name/email cards, applied per repository (never to your global git config). Accounts
          authenticate; identities author.
        </p>
      </div>

      <div className="mt-6">
        <ThisComputerRow identity={defaultIdentity} />
      </div>

      <ManualIdentitiesSection />
    </>
  );
}
