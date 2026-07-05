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
  selectedId,
  busy,
  onPick,
}: {
  remote: { name: string; fetchUrl: string; pushUrl: string };
  accounts: PickerAccount[];
  /** The resolved account id for this remote, or null for system credentials. */
  selectedId: string | null;
  busy: boolean;
  onPick: (id: string | null) => void;
}) => {
  const model = remoteAccountPickerModel(remote, accounts);

  return (
    <div className="mt-3 flex items-center gap-2.5 border-t border-black/[0.05] pt-3 dark:border-white/[0.06]">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500">
        Auth as
      </span>
      {model.matching.length > 0 ? (
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
        <span className="text-pretty text-[12px] text-neutral-500 dark:text-neutral-400">{model.note}</span>
      )}
    </div>
  );
};
