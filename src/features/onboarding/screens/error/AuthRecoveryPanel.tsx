// In-place recovery for an auth-failed clone: instead of a dead-end error the
// user picks a matching connected account, confirms their HTTPS helper/GCM
// setup, or follows SSH key guidance — plus a switch to the alternative
// transport. Token/keychain entry is intentionally hidden while the auth surface
// is simplified to CLI/GCM/SSH.

import { openExternalUrl } from "../../../../lib/openExternal";
import { useUi } from "../../../../store/ui";
import type { AuthRecovery } from "../../authRecovery";
import type { OnboardingApi } from "../../flows/useOnboarding";

const linkCls =
  "inline-flex items-center gap-1.5 text-[12px] font-semibold text-[color:var(--accent)] hover:underline";
const GCM_URL = "https://github.com/git-ecosystem/git-credential-manager#git-credential-manager";

export const AuthRecoveryPanel = ({ ob, recovery }: { ob: OnboardingApi; recovery: AuthRecovery }) => {
  return (
    <div className="mt-6 w-full rounded-2xl border border-black/[0.07] bg-black/[0.015] p-5 text-left dark:border-white/[0.08] dark:bg-white/[0.025]">
      {recovery.ssh ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
              SSH key
            </div>
            {recovery.host && (
              <span className="font-mono text-[12px] text-neutral-400 dark:text-neutral-500">{recovery.host}</span>
            )}
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            This is an SSH URL — access comes from an SSH key known to {recovery.forgeLabel}, not a
            token. Add your public key on the forge (and make sure ssh-agent has it loaded), then
            retry.
          </p>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {recovery.sshHelp.addUrl && (
              <button type="button" onClick={() => openExternalUrl(recovery.sshHelp.addUrl!)} className={linkCls}>
                Add an SSH key on {recovery.forgeLabel}
              </button>
            )}
            {recovery.sshHelp.docsUrl && (
              <button type="button" onClick={() => openExternalUrl(recovery.sshHelp.docsUrl!)} className={linkCls}>
                How to set up SSH keys
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[12px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
              Fix authentication
            </div>
            {recovery.credentialHost && (
              <span className="font-mono text-[12px] text-neutral-400 dark:text-neutral-500">
                {recovery.credentialHost}
              </span>
            )}
          </div>
          {ob.cloneForm.accounts.length > 0 && (
            <select
              value={ob.cloneForm.accountId ?? ""}
              onChange={(e) => ob.cloneForm.setAccountId(e.target.value || null)}
              className="mt-3 h-9 w-full rounded-lg border border-black/10 bg-white px-2.5 text-[13px] font-medium text-neutral-700 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200"
            >
              <option value="">Use Git credential helper or GCM…</option>
              {ob.cloneForm.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  Retry as @{a.login} via {a.forge}
                </option>
              ))}
            </select>
          )}
          {!ob.cloneForm.accountId && (
            <>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                For HTTPS, GitLane uses your configured Git credential helper or Git Credential Manager. If this
                provider requires a username in the URL, include it in the remote URL and retry.
              </p>
              <div className="mt-2.5 flex flex-col gap-1.5">
                <button type="button" onClick={() => openExternalUrl(GCM_URL)} className={linkCls}>
                  Git Credential Manager
                </button>
                {recovery.providerKey && (
                  <button
                    type="button"
                    onClick={() => useUi.getState().openAccountsSettings(recovery.providerKey ?? undefined)}
                    className={linkCls}
                  >
                    Check provider CLI setup
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {/* Footer: the sideways moves — the alternative transport (full switched
          URL in the tooltip) and the Accounts escape hatch. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-black/5 pt-3 dark:border-white/5">
        {!recovery.ssh && recovery.sshUrl ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            <span>Prefer SSH?</span>
            <button
              type="button"
              title={recovery.sshUrl}
              onClick={() => ob.cloneRecovery.retryWithUrl(recovery.sshUrl!)}
              className={linkCls}
            >
              Retry over SSH
            </button>
            {recovery.sshHelp.addUrl && (
              <button type="button" onClick={() => openExternalUrl(recovery.sshHelp.addUrl!)} className={linkCls}>
                Add an SSH key
              </button>
            )}
          </div>
        ) : recovery.ssh && recovery.httpsUrl ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-neutral-500 dark:text-neutral-400">
            <span>No SSH key handy?</span>
            <button
              type="button"
              title={recovery.httpsUrl}
              onClick={() => ob.cloneRecovery.retryWithUrl(recovery.httpsUrl!)}
              className={linkCls}
            >
              Switch to HTTPS
            </button>
            <span>— then use GCM or your Git credential helper.</span>
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => useUi.getState().openAccountsSettings(recovery.providerKey ?? undefined)}
          className="text-[12px] font-semibold text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          More sign-in options — Accounts settings…
        </button>
      </div>
    </div>
  );
};
