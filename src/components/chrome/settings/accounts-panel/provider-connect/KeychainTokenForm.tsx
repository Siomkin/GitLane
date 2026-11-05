// Paste a token as GitLane's own transport token for GitHub, GitLab or
// Bitbucket: it is stored in the OS keychain and fed to git by GitLane's
// askpass bridge, which sets the user's credential helpers aside for that host
// — so a stale helper entry cannot get in the way. Saved, then checked against
// the open remotes. Where the keychain is unavailable, the same token can go to
// the Git credential helper instead.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { DEFAULT_CREDENTIAL_HOST, defaultTransportUsername, FORGE_NAMES, isForgeAuthProvider } from "@/lib/forgeHelp";
import type { ForgeKind, TokenProvider } from "@/lib/api";
import { useAccounts } from "@/store/accounts";
import { openProviderRemote } from "@/store/accounts/credentialChecks";
import { inputCls } from "./ui";
import {
  CredentialSaveError,
  GITHUB_READ_ONLY_NOTE,
  RemoteCheckResults,
  githubPasswordWarning,
  secretPlaceholder,
  useCredentialSave,
} from "./credential-entry";

export function KeychainTokenForm({
  provider = "github",
  autoFocus = false,
  onHostChange,
}: {
  provider?: TokenProvider;
  autoFocus?: boolean;
  /** The typed host, so the surrounding guidance links that host's pages. */
  onHostChange?: (host: string) => void;
}) {
  const saveTransportToken = useAccounts((s) => s.saveTransportToken);
  const saveHttpsCredential = useAccounts((s) => s.saveHttpsCredential);
  const { outcome, busy, run, forgetThenRetry } = useCredentialSave();
  const github = provider === "github";
  const forge = FORGE_NAMES[provider as ForgeKind]?.label ?? provider;
  const defaultHost = DEFAULT_CREDENTIAL_HOST[provider] ?? "";
  // The open repo's remote for this provider picks the host (a cloud host, an
  // Enterprise or self-managed server) and the username its URL already carries.
  const [target] = useState(() => openProviderRemote(provider));
  const [host, setHost] = useState(() => target?.credentialHost ?? defaultHost);
  // A known host is shown as text with an Edit escape (Enterprise / self-hosted);
  // only a forge with no default host asks for it up front.
  const [hostEditable, setHostEditable] = useState(() => host === "");
  const [username, setUsername] = useState(() => target?.user ?? defaultTransportUsername(provider) ?? "");
  const [token, setToken] = useState("");
  // The last save went to the helper after the keychain refused: a missing
  // helper then means neither storage is available.
  const [viaHelper, setViaHelper] = useState(false);
  const warning = githubPasswordWarning(host, token);
  const disabled = busy || host.trim() === "" || username.trim() === "" || token.trim() === "";

  const settle = (next: { ok: boolean }) => {
    if (next.ok) setToken("");
  };
  const saveWithHelper = () => {
    setViaHelper(true);
    const tracked = isForgeAuthProvider(provider) ? provider : undefined;
    void run(() => saveHttpsCredential(host.trim(), null, username.trim(), token, tracked)).then(settle);
  };
  const save = () => {
    setViaHelper(false);
    void run(() => saveTransportToken(provider, host, username, token)).then(settle);
  };

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        {hostEditable && (
        <input
          value={host}
          onChange={(e) => {
            setHost(e.target.value);
            onHostChange?.(e.target.value);
          }}
          placeholder={github ? "Host (github.com or your GitHub Enterprise Server)" : `Host (${defaultHost || "your server"})`}
          aria-label={`${forge} host`}
          spellCheck={false}
          className={cn(inputCls, "sm:col-span-2")}
        />
        )}
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={`${forge} username`}
          aria-label={`${forge} username`}
          spellCheck={false}
          className={inputCls}
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={github ? secretPlaceholder("github") : "Access token"}
          aria-label={github ? "Personal access token" : "Access token"}
          type="password"
          spellCheck={false}
          autoFocus={autoFocus}
          className={inputCls}
        />
      </div>
      {!hostEditable && (
        <div className="mt-1.5 flex items-center gap-2 text-[11.5px] text-neutral-400 dark:text-neutral-500">
          <span>
            on <span className="font-mono text-neutral-500 dark:text-neutral-400">{host}</span>
          </span>
          <button
            type="button"
            onClick={() => setHostEditable(true)}
            className={cn(
              "font-semibold text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Edit
          </button>
        </div>
      )}
      {warning && <p className="mt-1.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">{warning}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={save}
          className={cn(
            "h-9 rounded-lg bg-[var(--accent)] px-3.5 text-[12.5px] font-semibold text-white disabled:opacity-40",
            focusRing,
          )}
        >
          {busy ? "Saving…" : "Save token"}
        </button>
      </div>
      {outcome?.ok === false && (
        <CredentialSaveError
          failure={outcome}
          busy={busy}
          keychainFailed={viaHelper}
          onUseHelper={saveWithHelper}
          onForgetShadowed={(name) => forgetThenRetry({ host: host.trim(), path: null }, name, saveWithHelper)}
        />
      )}
      {outcome?.ok === true && (
        <RemoteCheckResults
          checks={outcome.checks}
          note={outcome.note}
          readOnlyNote={github ? GITHUB_READ_ONLY_NOTE : undefined}
        />
      )}
    </div>
  );
}
