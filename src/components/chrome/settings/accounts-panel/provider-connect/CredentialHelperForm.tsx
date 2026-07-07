// Save an HTTPS token/password for a forge. Two destinations: the user's own Git
// credential helper (`git credential approve`, GitLane stores nothing) or the OS
// keychain that GitLane owns and feeds to git via GIT_ASKPASS (GL-132). Either
// way the secret crosses IPC once and is never persisted by GitLane in the clear.

import { useState } from "react";
import { cn } from "../../../../../lib/cn";
import { focusRing } from "../../../../../lib/ui";
import type { ForgeAuthStatus } from "../../../../../lib/api";
import { useAccounts } from "../../../../../store/accounts";
import { DEFAULT_CREDENTIAL_HOST } from "./oauth";

const inputCls = cn(
  "h-9 rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
  focusRing,
);

export function CredentialHelperForm({
  status,
  usernameHint,
}: {
  status: ForgeAuthStatus;
  usernameHint?: string | null;
}) {
  const saveHttpsCredential = useAccounts((s) => s.saveHttpsCredential);
  const saveProviderToken = useAccounts((s) => s.saveProviderToken);
  const [dest, setDest] = useState<"helper" | "keychain">("helper");
  const [host, setHost] = useState(DEFAULT_CREDENTIAL_HOST[status.provider] ?? "");
  const [path, setPath] = useState("");
  const [username, setUsername] = useState(usernameHint ?? "");
  const [password, setPassword] = useState("");
  const keychain = dest === "keychain";
  const disabled = host.trim() === "" || username.trim() === "" || password === "";

  const save = () => {
    const clear = () => setPassword("");
    if (keychain) {
      void saveProviderToken(status.provider, host, username, password).then(clear);
    } else {
      void saveHttpsCredential(host, path.trim() || null, username, password, status.provider).then(clear);
    }
  };

  const seg = (value: "helper" | "keychain", label: string) => (
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
        {seg("helper", "Git helper")}
        {seg("keychain", "GitLane keychain")}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host" spellCheck={false} className={inputCls} />
        {!keychain && (
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Path scope (optional)"
            spellCheck={false}
            className={inputCls}
          />
        )}
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
      </div>
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
