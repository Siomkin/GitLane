// The expanded auth section of the clone form: pick a connected gh account for
// GitHub, or set the HTTPS username that Git's configured credential helper/GCM
// should authenticate as. Token/keychain inputs are intentionally hidden while
// the auth surface is simplified to CLI/GCM/SSH.

import type { OnboardingApi } from "../../flows/useOnboarding";

export const CloneAuthOptions = ({ ob }: { ob: OnboardingApi }) => {
  const manual = !ob.cloneForm.accountId;
  return (
    <div className="mt-2.5 rounded-xl border border-black/[0.07] bg-black/[0.015] p-3.5 dark:border-white/[0.08] dark:bg-white/[0.025]">
      {ob.cloneForm.accounts.length > 0 && (
        <select
          value={ob.cloneForm.accountId ?? ""}
          onChange={(e) => ob.cloneForm.setAccountId(e.target.value || null)}
          className="mb-2 h-9 w-full rounded-lg border border-black/10 bg-white px-2.5 text-[13px] font-medium text-neutral-700 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
        >
          <option value="">System git credentials / username below</option>
          {ob.cloneForm.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.login} via {a.forge}
            </option>
          ))}
        </select>
      )}
      {manual && (
        <div>
          <input
            value={ob.cloneForm.username}
            onChange={(e) => ob.cloneForm.setUsername(e.target.value)}
            placeholder="HTTPS username"
            spellCheck={false}
            className="h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[13px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
          />
        </div>
      )}
      <p className="mt-2 text-[12px] leading-snug text-neutral-500 dark:text-neutral-400">
        GitLane runs real git. HTTPS credentials come from your configured Git credential helper or GCM; SSH URLs use
        your SSH key.
      </p>
    </div>
  );
};
