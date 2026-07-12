// A GitLane-owned provider token stored in the OS keychain (GL-132 PAT, GL-139
// OAuth), shown in the connected accounts list. This is the home for keychain
// tokens now that the per-remote keychain UI is gone: it's the only place they
// can be signed out. The token itself never leaves the keychain — this card
// holds only non-secret metadata.

import type { ForgeAuthProvider } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useAccounts } from "@/store/accounts";
import { useUi } from "@/store/ui";
import { PROVIDERS, providerInitials } from "./providers";

export interface KeychainAccount {
  provider: ForgeAuthProvider;
  credentialHost: string;
  /** Human display handle. */
  login: string;
  /** The URL/keychain-key username (sentinel for OAuth, the handle for a PAT). */
  transportUsername?: string;
}

function forgeName(provider: ForgeAuthProvider): string {
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
    <div className="flex items-center gap-3 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
        {providerInitials(forge)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">@{account.login}</span>
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{account.credentialHost}</span>
          <span className="grid h-[17px] place-items-center rounded-full bg-[color:var(--accent)]/12 px-2 text-[10px] font-semibold text-[color:var(--accent)]">
            Keychain token
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
          GitLane-owned token in your OS keychain, fed to git for fetch and push.
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
