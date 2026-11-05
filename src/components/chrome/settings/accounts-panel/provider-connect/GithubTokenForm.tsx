// Paste a GitHub personal access token as GitLane's own transport token: it is
// stored in the OS keychain and fed to git by GitLane's askpass bridge, which
// sets the user's credential helpers aside for that host — so a stale helper
// entry cannot get in the way. Saved, then checked against the open remotes.
// Where the keychain is unavailable, the same token can go to the Git
// credential helper instead.

import { useState } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { openExternalUrl } from "@/lib/openExternal";
import { tokenHelp } from "@/lib/forgeHelp";
import { useAccounts } from "@/store/accounts";
import { openGithubRemote } from "@/store/accounts/credentialChecks";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { inputCls, linkCls } from "./ui";
import {
  CredentialSaveError,
  RemoteCheckResults,
  githubPasswordWarning,
  secretPlaceholder,
  useCredentialSave,
} from "./credential-entry";

export function GithubTokenForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const saveGithubToken = useAccounts((s) => s.saveGithubToken);
  const saveHttpsCredential = useAccounts((s) => s.saveHttpsCredential);
  const { outcome, busy, run, forgetThenRetry } = useCredentialSave();
  // The open repo's GitHub remote picks the host (github.com or an Enterprise
  // Server) and the username its URL already carries.
  const [target] = useState(() => openGithubRemote());
  const [host, setHost] = useState(() => target?.credentialHost ?? "github.com");
  const [username, setUsername] = useState(() => target?.user ?? "");
  const [token, setToken] = useState("");
  // The last save went to the helper after the keychain refused: a missing
  // helper then means neither storage is available.
  const [viaHelper, setViaHelper] = useState(false);
  const warning = githubPasswordWarning(host, token);
  const createUrl = tokenHelp("github", host).createUrl;
  const disabled = busy || host.trim() === "" || username.trim() === "" || token.trim() === "";

  const settle = (next: { ok: boolean }) => {
    if (next.ok) setToken("");
  };
  const saveWithHelper = () => {
    setViaHelper(true);
    void run(() => saveHttpsCredential(host.trim(), null, username.trim(), token, undefined)).then(settle);
  };
  const save = () => {
    setViaHelper(false);
    void run(() => saveGithubToken(host, username, token)).then(settle);
  };

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="Host (github.com or your GitHub Enterprise Server)"
          aria-label="GitHub host"
          spellCheck={false}
          className={cn(inputCls, "sm:col-span-2")}
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="GitHub username"
          aria-label="GitHub username"
          spellCheck={false}
          className={inputCls}
        />
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={secretPlaceholder("github")}
          aria-label="Personal access token"
          type="password"
          spellCheck={false}
          autoFocus={autoFocus}
          className={inputCls}
        />
      </div>
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
        {createUrl && (
          <button type="button" onClick={() => openExternalUrl(createUrl)} className={linkCls}>
            <ExternalLinkIcon className="h-3.5 w-3.5" />
            Create a token
          </button>
        )}
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
      {outcome?.ok === true && <RemoteCheckResults checks={outcome.checks} note={outcome.note} />}
    </div>
  );
}
