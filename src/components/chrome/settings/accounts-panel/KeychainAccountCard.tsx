// A GitLane-owned provider token stored in the OS keychain (GL-132 PAT, GL-139
// OAuth), shown in the connected accounts list. This is the home for keychain
// tokens now that the per-remote keychain UI is gone: it's the only place they
// can be signed out. The token itself never leaves the keychain — this card
// holds only non-secret metadata.

import type { TokenProvider } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { ForgeIcon } from "@/components/chrome/forges";
import { PROVIDERS, prSupportedFor, providerInitials } from "./providers";

export interface KeychainAccount {
  provider: TokenProvider;
  credentialHost: string;
  /** Human display handle. */
  login: string;
  /** The URL/keychain-key username (sentinel for OAuth, the handle for a PAT). */
  transportUsername?: string;
}

function forgeName(provider: TokenProvider): string {
  return PROVIDERS.find((p) => p.key === provider)?.name ?? provider;
}

export function KeychainAccountCard({ account }: { account: KeychainAccount }) {
  const signOutProviderToken = useAccounts((s) => s.signOutProviderToken);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const forge = forgeName(account.provider);
  // signOutProviderToken keys on the token's transport username (its key
  // component), then resolves the real keychain locator internally.
  const keyLogin = account.transportUsername ?? account.login;

  const signOut = () =>
    requestConfirm({
      title: `Sign out of ${forge}?`,
      message:
        "Deletes GitLane's token for this account from your OS keychain. Remotes that used it will need a credential again.",
      confirmLabel: "Sign out",
      danger: true,
      onConfirm: () => void signOutProviderToken(account.provider, account.credentialHost, keyLogin),
    });

  return (
    // A plain row like its siblings: ProviderSection's list draws the box.
    <div className="flex items-center gap-3 px-3.5 py-3">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
        {providerInitials(forge)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">@{account.login}</span>
          <span className="inline-flex items-center gap-1 text-[11.5px] text-neutral-500 dark:text-neutral-400">
            <ForgeIcon kind={account.provider} className="h-3 w-3" />
            {account.credentialHost}
          </span>
          <span className="grid h-[17px] place-items-center rounded-full border border-black/10 bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:border-white/10 dark:bg-white/[0.06] dark:text-neutral-400">
            Keychain token
          </span>
          {/* Same marker as the gh row: this token also serves PR requests. */}
          {prSupportedFor(account.provider) && (
            <span className="inline-flex h-[17px] items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              PRs enabled
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
          Signed in with a token in your OS keychain · fetch, push and pull requests
        </div>
      </div>
      <button type="button"
        onClick={signOut}
        className={cn(
          "shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400",
          focusRing,
        )}
      >
        Sign out
      </button>
    </div>
  );
}
