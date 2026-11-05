// Outcome state for one credential form, plus the confirmed
// "forget the shadowing entry, then save again" recovery the helper path offers.

import { useState } from "react";
import { useAccounts } from "@/store/accounts";
import type { CredentialSaveOutcome } from "@/store/accounts/credentialChecks";
import { useUi } from "@/store/ui";

export function useCredentialSave() {
  const forgetHttpsCredential = useAccounts((s) => s.forgetHttpsCredential);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const [outcome, setOutcome] = useState<CredentialSaveOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  /** Run one save; resolves the outcome so the caller can clear its secret. */
  const run = async (save: () => Promise<CredentialSaveOutcome>): Promise<CredentialSaveOutcome> => {
    setBusy(true);
    setOutcome(null);
    try {
      const next = await save();
      setOutcome(next);
      return next;
    } finally {
      setBusy(false);
    }
  };

  /** After a confirmation, forget the credential `username` holds on this
   * host/path in the user's helper, then run `retry` once. */
  const forgetThenRetry = (
    scope: { host: string; path: string | null },
    username: string,
    retry: () => void,
  ) =>
    requestConfirm({
      title: `Forget @${username} on ${scope.host}?`,
      message: `Your Git credential helper returns a saved credential for @${username} before the one you are saving. GitLane asks Git to forget that one entry, then saves yours again.`,
      confirmLabel: "Forget and save again",
      danger: true,
      onConfirm: () => {
        // No provider: this erases another helper's stale entry, not the
        // forge credential marker the save about to run re-records.
        // Inline: a toast would sit under the Settings modal.
        void forgetHttpsCredential(scope.host, scope.path, username, undefined, true).then((error) => {
          if (error === null) return retry();
          setOutcome({
            ok: false,
            message: `Git could not forget the saved credential for @${username}: ${error}`,
            shadowedUsername: null,
            keychainUnavailable: false,
            noCredentialHelper: false,
          });
        });
      },
    });

  return { outcome, setOutcome, busy, run, forgetThenRetry };
}
