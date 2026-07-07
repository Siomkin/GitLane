// An authenticated non-GitHub provider, shown in the connected accounts list.
// Consistency with GitHub: if you're signed in to the provider's CLI it appears
// here automatically (you don't "add" it in-app) — but plainly auth-only and
// PR-less, so it never reads as equivalent to a GitHub account.
//
// The real account identity is resolved by a separate network whoami, so this
// card renders as soon as auth is known and shows an identity skeleton until
// the whoami lands (it can take a couple of seconds — the user may navigate
// away otherwise).

import type { ForgeAuthStatus } from "../../../../lib/api";
import { accountHandle, providerInitials } from "./providers";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { useAccounts } from "../../../../store/accounts";
import { useUi } from "../../../../store/ui";

const SIGNOUT_SUPPORTED = new Set(["gitlab", "azure-devops"]);

export function ConnectedForgeCard({
  status,
  loading = false,
}: {
  status: ForgeAuthStatus;
  loading?: boolean;
}) {
  const signOutForge = useAccounts((s) => s.signOutForge);
  const signOutForgeCredential = useAccounts((s) => s.signOutForgeCredential);
  const requestConfirm = useUi((s) => s.requestConfirm);
  const account = status.account;
  const resolving = loading && !account;
  // A CLI-less provider (Bitbucket) is only ever "signed in" via a saved HTTPS
  // credential — sign-out there means forgetting that credential, not a CLI logout.
  const savedCredentialSignIn = status.cli === null && status.authenticated === true;
  const canSignOut = SIGNOUT_SUPPORTED.has(status.provider) || savedCredentialSignIn;
  const signOut = () =>
    requestConfirm({
      title: `Sign out of ${status.forge}?`,
      message: savedCredentialSignIn
        ? "Forgets the saved HTTPS credential for this host from your Git credential helper. Remotes stay configured; they'll just need a credential again."
        : "This signs out of the provider CLI on this machine. Existing remotes still keep their HTTPS usernames and any credentials saved in your Git credential helper.",
      confirmLabel: "Sign out",
      danger: true,
      onConfirm: () =>
        void (savedCredentialSignIn
          ? signOutForgeCredential(status.provider)
          : signOutForge(status.provider)),
    });
  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/[0.07] bg-black/[0.02] p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-[12px] font-bold text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
        {providerInitials(status.forge)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">
            {account ? accountHandle(account) : status.forge}
          </span>
          {account && (
            <span className="text-[11px] text-neutral-400 dark:text-neutral-500">{status.forge}</span>
          )}
          <span className="grid h-[17px] place-items-center rounded-full bg-black/[0.05] px-2 text-[10px] font-semibold text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
            Sign-in only
          </span>
        </div>
        {resolving ? (
          <div className="mt-1.5 flex items-center gap-2" aria-busy="true">
            <span className="h-3 w-44 animate-pulse rounded bg-black/10 dark:bg-white/15" />
            <span className="sr-only">Resolving account…</span>
          </div>
        ) : (
          <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
            {account?.name ? `${account.name} · ` : ""}
            {status.cli ? `signed in via ${status.cli}` : status.authMethod} ·{" "}
            {status.provider === "gitlab" && status.cli === "glab" && status.available === true
              ? "git transport authenticates through glab"
              : "git transport uses remote usernames and your credential helper"}
          </div>
        )}
      </div>
      {canSignOut && (
        <button
          onClick={signOut}
          className={cn(
            "shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] font-medium text-neutral-500 transition hover:bg-rose-500/10 hover:text-rose-600 dark:text-neutral-400 dark:hover:text-rose-400",
            focusRing,
          )}
        >
          Sign out
        </button>
      )}
    </div>
  );
}
