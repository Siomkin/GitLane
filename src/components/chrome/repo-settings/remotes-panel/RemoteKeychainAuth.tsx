import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { detectRemoteUrl } from "../../../../lib/remotes";
import type { ForgeAuthProvider } from "../../../../lib/api";
import { useAccounts } from "../../../../store/accounts";

/** The classified non-GitHub providers GitLane can hold a keychain token for
 * today (GL-132). GitHub uses `gh`; SSH uses keys; unclassified "other" hosts are
 * deferred to the per-provider work (GL-137). */
const PROVIDER_FOR: Partial<Record<string, ForgeAuthProvider>> = {
  gitlab: "gitlab",
  bitbucket: "bitbucket",
  azure: "azure-devops",
};

const INPUT = cn(
  "h-8 rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] text-neutral-700 placeholder:text-neutral-400 disabled:opacity-40 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
  focusRing,
);

/** Per-remote **GitLane-owned keychain token** auth (GL-132): store a provider
 * token in the OS keychain (the backend feeds it to git via GIT_ASKPASS), sign
 * out of it, or forget a saved Git-helper credential. These three verbs are kept
 * visibly distinct — provider sign-out removes GitLane's own secret; "forget
 * saved credential" only clears what the user's Git credential helper stored.
 *
 * Self-contained: reads/dispatches the account store directly so it slots into
 * `RemoteRow` without threading callbacks through the remotes panel. Renders
 * nothing for SSH, GitHub, or unclassified hosts. */
export const RemoteKeychainAuth = ({
  remote,
}: {
  remote: { name: string; fetchUrl: string; pushUrl: string };
}) => {
  const providerTokens = useAccounts((s) => s.providerTokens);
  const saveProviderToken = useAccounts((s) => s.saveProviderToken);
  const signOutProviderToken = useAccounts((s) => s.signOutProviderToken);
  const forgetHttpsCredential = useAccounts((s) => s.forgetHttpsCredential);

  const info = detectRemoteUrl(remote.pushUrl || remote.fetchUrl);
  const provider = info.provider ? PROVIDER_FOR[info.provider] : undefined;

  const [draft, setDraft] = useState(info.user ?? "");
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setDraft(info.user ?? "");
    setSecret("");
    // Re-seed when the remote's URL (and thus its username) changes.
  }, [info.user, remote.fetchUrl, remote.pushUrl]);

  // Only classified non-GitHub HTTPS remotes get the keychain path today.
  if (info.ssh || !info.credentialHost || !provider) return null;

  const credentialHost = info.credentialHost;
  const user = draft.trim();
  const stored = Object.values(providerTokens).find(
    (t) =>
      t.credentialHost.toLowerCase() === credentialHost.toLowerCase() &&
      t.login.toLowerCase() === user.toLowerCase() &&
      user !== "",
  );

  const run = async (fn: () => Promise<void>) => {
    setPending(true);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        Keychain
      </span>
      {stored ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span className="text-[12px] text-neutral-600 dark:text-neutral-300">
            Signed in as{" "}
            <span className="font-mono text-neutral-800 dark:text-neutral-100">@{stored.login}</span>{" "}
            — token stored in your OS keychain.
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(() =>
                signOutProviderToken(stored.provider, stored.credentialHost, stored.login),
              )
            }
            className={cn(
              "h-8 rounded-lg border border-black/10 px-2.5 text-[12px] font-semibold text-neutral-600 disabled:opacity-40 dark:border-white/[0.14] dark:text-neutral-300",
              focusRing,
            )}
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              disabled={pending}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Account username"
              spellCheck={false}
              className={cn(INPUT, "w-[170px] font-mono placeholder:font-sans")}
            />
            <input
              value={secret}
              disabled={pending}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Personal access token"
              type="password"
              spellCheck={false}
              className={cn(INPUT, "w-[190px]")}
            />
            <button
              type="button"
              disabled={pending || user === "" || secret === ""}
              onClick={() =>
                void run(async () => {
                  await saveProviderToken(provider, credentialHost, user, secret);
                  setSecret("");
                })
              }
              className={cn(
                "h-8 rounded-lg bg-[var(--accent)] px-2.5 text-[12px] font-semibold text-white disabled:opacity-40",
                focusRing,
              )}
            >
              Store in keychain
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        disabled={pending || user === ""}
        title="Erase a credential your Git credential helper saved (not a GitLane keychain token)"
        onClick={() =>
          void run(() => forgetHttpsCredential(credentialHost, info.path, user, provider))
        }
        className={cn(
          "h-8 rounded-lg px-2 text-[12px] font-medium text-neutral-500 hover:bg-black/[0.04] disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-white/[0.06]",
          focusRing,
        )}
      >
        Forget saved credential
      </button>
    </div>
  );
};
