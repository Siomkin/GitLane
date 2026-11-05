// The "connected" line above a provider's method switch. A GitLane-owned
// keychain token is what powers pull/merge requests (the git-helper credential
// covers transport only) and isn't reflected in the backend `authenticated`
// probe, so it leads; otherwise a signed-in CLI. Nothing when neither.

import type { ForgeAuthStatus } from "@/lib/api";
import type { StoredProviderToken } from "@/store/accounts";
import { accountHandle, prSupportedFor } from "@/components/chrome/settings/accounts-panel/providers";

const boxCls = "rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-2.5";
const headCls = "text-[12.5px] font-semibold text-emerald-700 dark:text-emerald-400";
const bodyCls = "mt-0.5 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400";

export function ConnectedBanner({
  status,
  keychainToken,
  resolving,
}: {
  status: ForgeAuthStatus;
  keychainToken: StoredProviderToken | null;
  /** The background whoami is in flight and no account has landed yet. */
  resolving: boolean;
}) {
  const cli = status.cli ?? "";
  if (keychainToken) {
    return (
      <div className={boxCls}>
        <div className={headCls}>Pull requests ready — {accountHandle({ username: keychainToken.login })}</div>
        <p className={bodyCls}>
          GitLane authenticates {status.forge} pull requests with a token in your OS keychain
          {keychainToken.credentialHost ? (
            <>
              {" "}
              on <span className="font-mono">{keychainToken.credentialHost}</span>
            </>
          ) : null}
          . Git transport still uses your remote’s configured credentials.
        </p>
      </div>
    );
  }
  if (status.authenticated !== true) return null;
  return (
    <div className={boxCls}>
      <div className={headCls}>
        {status.account
          ? `Signed in as ${accountHandle(status.account)}`
          : resolving
            ? "Signed in — resolving account…"
            : `Signed in to ${cli}`}
      </div>
      <p className={bodyCls}>
        {!prSupportedFor(status.provider) ? (
          <>Authenticated for git transport. Pull requests aren’t available for {status.forge} in GitLane yet.</>
        ) : status.cli ? (
          <>
            Authenticated for git transport. Pull requests for {status.forge} work through the{" "}
            <code className="font-mono">{cli}</code> CLI when that provider supports it.
          </>
        ) : (
          <>Authenticated for git transport. Pull requests still need a provider API credential path in GitLane.</>
        )}
      </p>
    </div>
  );
}
