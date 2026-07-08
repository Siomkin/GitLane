// The expanded manual-auth section of the clone form: pick a connected gh
// account for the URL's host, or enter a username + token. For a PR-capable
// forge (Bitbucket/GitLab) the token defaults to GitLane's keychain so it powers
// pull requests too (GL-152) — a checkbox opts back to the git helper, mirroring
// the recovery panel's TokenEntrySteps. Hidden by default: the status line
// (CloneAuthStatus) already says how the clone will authenticate; this is the
// override for the rare manual case.

import { forgeAuthProviderFor } from "../../../../lib/remotes";
import type { OnboardingApi } from "../../flows/useOnboarding";

export const CloneAuthOptions = ({ ob }: { ob: OnboardingApi }) => {
  const forgeProvider = forgeAuthProviderFor(ob.cloneRemoteInfo.provider);
  const prCapable = forgeProvider === "bitbucket" || forgeProvider === "gitlab";
  const manual = !ob.cloneAccountId;
  // Matches startClone's keychain gate: PR-capable forge, manual entry, the
  // checkbox on, and a username to key the token by. Otherwise the token lands
  // in the git helper — so the footnote never claims a destination the clone
  // won't use.
  const willUseKeychain =
    prCapable && manual && (ob.cloneKeychain ?? true) && ob.cloneUsername.trim() !== "";
  return (
    <div className="mt-2.5 rounded-xl border border-black/[0.07] bg-black/[0.015] p-3.5 dark:border-white/[0.08] dark:bg-white/[0.025]">
      {ob.cloneAuthAccounts.length > 0 && (
        <select
          value={ob.cloneAccountId ?? ""}
          onChange={(e) => ob.setCloneAccountId(e.target.value || null)}
          className="mb-2 h-9 w-full rounded-lg border border-black/10 bg-white px-2.5 text-[13px] font-medium text-neutral-700 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
        >
          <option value="">System git credentials / username below</option>
          {ob.cloneAuthAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.login} via {a.forge}
            </option>
          ))}
        </select>
      )}
      {manual && (
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={ob.cloneUsername}
            onChange={(e) => ob.setCloneUsername(e.target.value)}
            placeholder="HTTPS username"
            spellCheck={false}
            className="h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[13px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
          />
          <input
            value={ob.clonePassword}
            onChange={(e) => ob.setClonePassword(e.target.value)}
            placeholder="Token / password"
            type="password"
            spellCheck={false}
            className="h-9 rounded-lg border border-black/10 bg-white px-2.5 text-[13px] text-neutral-700 placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
          />
        </div>
      )}
      {manual && prCapable && (
        <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[12.5px] text-neutral-600 dark:text-neutral-300">
          <input
            type="checkbox"
            checked={ob.cloneKeychain ?? true}
            onChange={(e) => ob.setCloneKeychain(e.target.checked)}
            className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--accent)]"
          />
          <span>
            Also enable pull requests
            <span className="block text-[12px] leading-snug text-neutral-400 dark:text-neutral-500">
              Keeps this token in GitLane's keychain so it powers pull requests too, not just git.
            </span>
          </span>
        </label>
      )}
      <p className="mt-2 text-[12px] leading-snug text-neutral-500 dark:text-neutral-400">
        {willUseKeychain
          ? "GitLane keeps the token in its keychain — powering pull requests too — before clone."
          : "GitLane saves the token/password to your Git credential helper before clone."}
      </p>
    </div>
  );
};
