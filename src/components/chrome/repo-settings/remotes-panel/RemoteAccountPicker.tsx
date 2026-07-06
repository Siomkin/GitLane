import type { ForgeAuthStatus } from "../../../../lib/api";
import { useEffect, useState } from "react";
import { cn } from "../../../../lib/cn";
import { focusRing } from "../../../../lib/ui";
import { remoteAccountPickerModel, type PickerAccount } from "./remoteAccountOptions";

/** Sentinel option value for "no bound account" — the select needs a string. */
const SYSTEM = "";

/** Which account this remote's pushes/fetches authenticate as (GL-129).
 * "System git credentials" is always offered; for a host with no matching
 * connected account it is the only behaviour, explained by a note instead of
 * a one-option picker. */
export const RemoteAccountPicker = ({
  remote,
  accounts,
  forgeAuth,
  selectedId,
  busy,
  onPick,
  onSetUsername,
  onSaveCredential,
}: {
  remote: { name: string; fetchUrl: string; pushUrl: string };
  accounts: PickerAccount[];
  /** CLI auth probes for non-GitHub forges — keeps the note in step with the
   * Accounts page (a glab sign-in is acknowledged, not denied). */
  forgeAuth: ForgeAuthStatus[];
  /** The resolved account id for this remote, or null for system credentials. */
  selectedId: string | null;
  busy: boolean;
  onPick: (id: string | null) => void;
  onSetUsername: (username: string | null) => void;
  onSaveCredential: (username: string, password: string) => void;
}) => {
  const model = remoteAccountPickerModel(remote, accounts, forgeAuth);
  const [draft, setDraft] = useState(model.username ?? "");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    setDraft(model.username ?? "");
    setSecret("");
  }, [model.username, remote.fetchUrl, remote.pushUrl]);

  const usernameChanged = draft.trim() !== (model.username ?? "");
  const canSaveCredential = draft.trim() !== "" && secret !== "";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        Account
      </span>
      {model.ssh ? (
        <span className="text-pretty text-[12px] text-neutral-500 dark:text-neutral-400">{model.note}</span>
      ) : model.matching.length > 0 ? (
        <select
          aria-label={`Account for ${remote.name}`}
          value={selectedId ?? SYSTEM}
          disabled={busy}
          onChange={(e) => onPick(e.target.value === SYSTEM ? null : e.target.value)}
          className={cn(
            "h-8 max-w-[300px] rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] font-medium text-neutral-700 disabled:opacity-40 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
            focusRing,
          )}
        >
          <option value={SYSTEM}>System git credentials</option>
          {model.matching.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.login}
              {a.healthy ? "" : " — needs re-auth"}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="HTTPS username"
              spellCheck={false}
              className={cn(
                "h-8 w-[190px] rounded-lg border border-black/10 bg-white px-2.5 font-mono text-[12.5px] text-neutral-700 placeholder:font-sans placeholder:text-neutral-400 disabled:opacity-40 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
                focusRing,
              )}
            />
            <input
              value={secret}
              disabled={busy}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Token / password"
              type="password"
              spellCheck={false}
              className={cn(
                "h-8 w-[190px] rounded-lg border border-black/10 bg-white px-2.5 text-[12.5px] text-neutral-700 placeholder:text-neutral-400 disabled:opacity-40 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
                focusRing,
              )}
            />
            <button
              type="button"
              disabled={busy || !usernameChanged}
              onClick={() => onSetUsername(draft.trim() || null)}
              className={cn(
                "h-8 rounded-lg border border-black/10 px-2.5 text-[12px] font-semibold text-neutral-600 disabled:opacity-40 dark:border-white/[0.14] dark:text-neutral-300",
                focusRing,
              )}
            >
              Apply username
            </button>
            <button
              type="button"
              disabled={busy || !canSaveCredential}
              onClick={() => {
                onSaveCredential(draft.trim(), secret);
                setSecret("");
              }}
              className={cn(
                "h-8 rounded-lg bg-[var(--accent)] px-2.5 text-[12px] font-semibold text-white disabled:opacity-40",
                focusRing,
              )}
            >
              Save credential
            </button>
          </div>
          <span className="min-w-[220px] flex-1 text-pretty text-[12px] text-neutral-500 dark:text-neutral-400">
            {model.note}
          </span>
        </div>
      )}
    </div>
  );
};
