import type { ForgeAuthStatus } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useAccounts } from "@/store/accounts";
import type { AccountsConnectIntent } from "@/store/ui";
import { connectIntentFor, providerLabel } from "@/lib/remotes";
import { PlusIcon } from "@/components/ui/icons";
import { remoteAccountPickerModel, type PickerAccount } from "./remoteAccountOptions";
import { Select } from "@/components/ui/Select";

/** Sentinel option value for "no bound account" — the select needs a string. */
const SYSTEM = "";

/** Which account this remote's pushes/fetches authenticate as (GL-129).
 * Selection only: a `<select>` when connected accounts match this remote's host,
 * otherwise a note explaining how it authenticates. Entering a credential (a
 * token in the keychain or your git helper) and setting a raw HTTPS username
 * both live elsewhere — the Accounts page and the remote URL (Edit) — so this
 * panel never shows an entry form. */
export const RemoteAccountPicker = ({
  remote,
  accounts,
  forgeAuth,
  selectedId,
  busy,
  onPick,
  onConnect,
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
  /** Hand off to Settings → Accounts on this provider's connect view. */
  onConnect: (intent: AccountsConnectIntent) => void;
}) => {
  const providerTokens = useAccounts((s) => s.providerTokens);
  const model = remoteAccountPickerModel(remote, accounts, forgeAuth);
  // A keychain token wins over glab/system in transport, so the note must say so
  // rather than naming a mechanism that isn't actually used (review finding 11).
  // SSH remotes are excluded: they authenticate via the SSH key, and the token is
  // never consulted (the model's SSH note already explains this).
  // Only when transport actually resolves to it: a gh-bound GitHub remote
  // still authenticates as that gh account.
  const hasKeychainToken =
    !model.ssh &&
    !!model.credentialHost &&
    Object.values(providerTokens).some(
      (t) => t.credentialHost.toLowerCase() === model.credentialHost!.toLowerCase(),
    ) &&
    (selectedId === null || !model.matching.some((a) => a.id === selectedId));
  const note = hasKeychainToken ? "Authenticates with a token stored in your OS keychain." : model.note;
  // SSH authenticates by key, and an unknown forge has no connect view; a
  // keychain token already authenticates this host.
  const connectIntent = model.ssh || hasKeychainToken ? null : connectIntentFor(model.provider);
  const hasPicker = model.matching.length > 0;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2.5 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        Account
      </span>
      {hasPicker ? (
        <Select
          aria-label={`Account for ${remote.name}`}
          value={selectedId ?? SYSTEM}
          disabled={busy}
          onChange={(e) => onPick(e.target.value === SYSTEM ? null : e.target.value)}
          className={cn(
            "h-8 max-w-[300px] rounded-lg border border-black/10 bg-white pl-2.5 text-[12.5px] font-medium text-neutral-700 dark:border-white/[0.14] dark:bg-neutral-800 dark:text-neutral-200",
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
        </Select>
      ) : (
        <span className="min-w-0 flex-1 text-pretty text-[12px] text-neutral-500 dark:text-neutral-400">{note}</span>
      )}
      {connectIntent &&
        (hasPicker ? (
          <button type="button"
            onClick={() => onConnect(connectIntent)}
            className={cn(
              "h-8 rounded-lg px-2 text-[12.5px] font-medium text-neutral-500 hover:bg-black/[0.05] hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/[0.06] dark:hover:text-neutral-200",
              focusRing,
            )}
          >
            Connect another…
          </button>
        ) : (
          <button type="button"
            onClick={() => onConnect(connectIntent)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-black/10 px-3 text-[12.5px] font-semibold text-neutral-700 hover:bg-black/[0.04] dark:border-white/15 dark:text-neutral-200 dark:hover:bg-white/[0.06]",
              focusRing,
            )}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Connect {providerLabel(model.provider)} account…
          </button>
        ))}
    </div>
  );
};
