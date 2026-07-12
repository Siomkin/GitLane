// Save an HTTPS token/password for a forge. The GCM/helper setup card embeds
// this in helper-only mode: GitLane sends the credential once to
// `git credential approve`, then Git Credential Manager / the configured helper
// owns storage. The older keychain destination remains for compatibility where
// this form is reused, but it is not shown by the simplified setup cards.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import {
  defaultTransportUsername,
  isForgeAuthProvider,
  supportsProviderTokenAuth,
} from "@/lib/forgeHelp";
import type { ForgeAuthProvider } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { inputCls } from "@/components/chrome/settings/accounts-panel/provider-connect/ui";
import { canSubmit, hostFieldInitiallyEditable, resolveHost } from "./credentialEntry";

export type CredentialDestination = "helper" | "keychain";

export function CredentialEntryForm({
  provider,
  usernameHint,
  helperOnly = false,
}: {
  provider: string;
  usernameHint?: string | null;
  helperOnly?: boolean;
}) {
  const saveHttpsCredential = useAccounts((s) => s.saveHttpsCredential);
  const saveProviderToken = useAccounts((s) => s.saveProviderToken);
  const keychainAvailable = !helperOnly && supportsProviderTokenAuth(provider);
  const [dest, setDest] = useState<CredentialDestination>(() => (keychainAvailable ? "keychain" : "helper"));
  const [host, setHost] = useState(() => resolveHost(provider));
  const [hostEditable, setHostEditable] = useState(() => hostFieldInitiallyEditable(provider));
  const [advanced, setAdvanced] = useState(false);
  const [path, setPath] = useState("");
  const [username, setUsername] = useState(() => usernameHint ?? defaultTransportUsername(provider) ?? "");
  const [password, setPassword] = useState("");
  const keychain = dest === "keychain";
  const disabled = !canSubmit({ host, path, username, password });

  const submit = () => {
    const clear = () => setPassword("");
    if (keychain) {
      // Keep the pasted token on a failed save so the user can retry without
      // re-pasting — saveProviderToken resolves false (and toasts) on failure.
      if (!supportsProviderTokenAuth(provider)) return;
      void saveProviderToken(provider, host.trim(), username.trim(), password).then((ok) => {
        if (ok) clear();
      });
    } else {
      const trackedProvider: ForgeAuthProvider | undefined = isForgeAuthProvider(provider) ? provider : undefined;
      void saveHttpsCredential(host.trim(), path.trim() || null, username.trim(), password, trackedProvider).then((ok) => {
        if (ok) clear();
      });
    }
  };

  const seg = (value: CredentialDestination, label: string) => (
    <button
      type="button"
      onClick={() => setDest(value)}
      className={cn(
        "h-7 rounded-md px-2.5 text-[11.5px] font-semibold transition",
        dest === value
          ? "bg-[var(--accent)] text-white"
          : "text-neutral-500 hover:bg-black/[0.04] dark:text-neutral-400 dark:hover:bg-white/[0.06]",
      )}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-2 inline-flex items-center gap-1 rounded-lg border border-black/10 p-0.5 dark:border-white/[0.12]">
        {helperOnly ? (
          <span className="px-2.5 py-1 text-[11.5px] font-semibold text-neutral-500 dark:text-neutral-400">
            Git Credential Manager / helper
          </span>
        ) : (
          <>
            {seg("helper", "Git helper")}
            {seg("keychain", "GitLane keychain")}
          </>
        )}
      </div>
      {helperOnly && (
        <p className="mb-2 text-[11.5px] leading-relaxed text-neutral-400 dark:text-neutral-500">
          Save or update the HTTPS credential Git will request from GCM or your configured helper for this host.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="HTTPS username"
          spellCheck={false}
          className={inputCls}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Token / password"
          type="password"
          spellCheck={false}
          className={cn(
            "h-9 rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] text-neutral-700 placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        />
        {hostEditable && (
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host" spellCheck={false} className={inputCls} />
        )}
        {advanced && !keychain && (
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Path scope (optional)"
            spellCheck={false}
            className={inputCls}
          />
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-neutral-400 dark:text-neutral-500">
        <span>
          on{" "}
          <span className="font-mono text-neutral-500 dark:text-neutral-400">{hostEditable ? host || "…" : host}</span>
        </span>
        {!hostEditable && (
          <button
            type="button"
            onClick={() => setHostEditable(true)}
            className="font-semibold text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Edit
          </button>
        )}
        {!keychain && !advanced && (
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className="font-semibold text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Advanced…
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={submit}
          className={cn(
            "h-9 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40",
            focusRing,
          )}
        >
          {keychain ? "Store in keychain" : "Save credential"}
        </button>
        <span className="text-[11.5px] leading-snug text-neutral-400 dark:text-neutral-500">
          {keychain ? (
            "GitLane keeps this token in your OS keychain and feeds it to git for you."
          ) : (
            <>
              GitLane sends this once to <span className="font-mono">git credential approve</span>; your configured
              helper stores it.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
