// The token path of the recovery panel, shaped as a 30-second task: 1) create
// a token on the forge, 2) paste it. The HTTPS username is a protocol detail —
// on forges that accept a token with a fixed username it stays a managed,
// explained fact (prefilled with the recommended token's convention, e.g.
// Bitbucket repository access tokens' x-token-auth) behind a "use a different
// username" escape; forges that need the real account name (Gitea/Forgejo/
// unknown) show it as a field. Inputs bind to the clone flow's state — the
// screen's bottom Retry reruns the clone with them.

import { useEffect, useState } from "react";
import { openExternalUrl } from "../../../../lib/openExternal";
import type { AuthRecovery } from "../../authRecovery";
import type { OnboardingApi } from "../../flows/useOnboarding";

const linkCls =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] hover:underline";
const inputCls =
  "h-9 w-full rounded-lg border border-black/10 bg-white px-2.5 text-[13px] text-neutral-700 placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200";

const Step = ({ n, children }: { n: number | null; children: React.ReactNode }) => (
  <div className="mt-3 flex gap-2.5">
    {n !== null && (
      <span className="mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-[var(--accent-soft)] text-[11.5px] font-semibold text-[color:var(--accent)]">
        {n}
      </span>
    )}
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

export const TokenEntrySteps = ({ ob, recovery }: { ob: OnboardingApi; recovery: AuthRecovery }) => {
  const [showUsername, setShowUsername] = useState(!recovery.usernameOptional);
  const managed = recovery.defaultUsername;
  const usingManaged = !!managed && ob.cloneUsername === managed;
  // Bitbucket / GitLab tokens can also serve pull requests when kept in the
  // keychain (GL-152) — offer it as a checkbox, default on.
  const prCapable = recovery.providerKey === "bitbucket" || recovery.providerKey === "gitlab";

  // Adopt the recommended token's username unless the user carried an explicit
  // one of their own — the clone form auto-seeds the URL's userinfo, which we
  // treat as adoptable (a repo access token needs x-token-auth, not the handle
  // someone happened to paste into the URL). Mount-once, and only when the
  // username is still the seeded/blank value, so it never clobbers an edit.
  useEffect(() => {
    if (recovery.ssh || !recovery.usernameOptional || !managed) return;
    const seeded = ob.cloneUsername === "" || ob.cloneUsername === recovery.urlUser;
    if (seeded && ob.cloneUsername !== managed) ob.setCloneUsername(managed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt once per mount
  }, []);

  return (
    <>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
        Sign in with {recovery.tokenNoun} to access this repository — it only takes a minute.
      </p>
      {recovery.tokenUrl && (
        <Step n={1}>
          <div className="pt-0.5 text-[13px] text-neutral-500 dark:text-neutral-400">
            <button type="button" onClick={() => openExternalUrl(recovery.tokenUrl!)} className={`${linkCls} text-[13px]`}>
              Create a token on {recovery.forgeLabel}
            </button>{" "}
            — {recovery.tokenHint ?? "copy it once it's shown."}
          </div>
        </Step>
      )}
      <Step n={recovery.tokenUrl ? 2 : null}>
        <input
          value={ob.clonePassword}
          onChange={(e) => ob.setClonePassword(e.target.value)}
          placeholder={`Paste your ${recovery.tokenNoun.replace(/^an? /, "")}`}
          type="password"
          spellCheck={false}
          className={inputCls}
        />
        {showUsername ? (
          <>
            <input
              value={ob.cloneUsername}
              onChange={(e) => ob.setCloneUsername(e.target.value)}
              placeholder="HTTPS username"
              spellCheck={false}
              className={`${inputCls} mt-2 font-mono placeholder:font-sans`}
            />
            {recovery.provider === "bitbucket" && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400 dark:text-neutral-500">
                Repository and workspace access tokens use{" "}
                <span className="font-mono">x-token-auth</span> (prefilled). A personal Atlassian
                API token uses your Bitbucket username or{" "}
                <span className="font-mono">x-bitbucket-api-token-auth</span>.
              </p>
            )}
          </>
        ) : (
          <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-400 dark:text-neutral-500">
            {ob.cloneUsername ? (
              <>
                Signs in as <span className="font-mono">{ob.cloneUsername}</span>
                {usingManaged
                  ? ` — the fixed username for ${recovery.tokenNoun}. GitLane fills it in for you. `
                  : !ob.clonePassword
                    ? // The token box clears once a token is saved to the git
                      // helper, so an empty retry silently reuses whatever the
                      // helper holds — say so, or a stale credential loops the
                      // same failure with no visible cause.
                      " — without a new token, Retry reuses the credential your Git helper already has saved for it. "
                    : ". "}
              </>
            ) : (
              <>The token is all you need — GitLane saves it to your Git credential helper. </>
            )}
            <button
              type="button"
              onClick={() => setShowUsername(true)}
              className="font-semibold text-[color:var(--accent)] hover:underline"
            >
              {ob.cloneUsername ? "Use a different username" : "Set a username"}
            </button>
          </p>
        )}
        {prCapable && (
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
      </Step>
    </>
  );
};
