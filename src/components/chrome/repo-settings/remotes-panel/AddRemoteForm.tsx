import { useState } from "react";
import { focusRing } from "@/lib/ui";
import { PlusIcon } from "@/components/ui/icons";
import { isValidRemoteName, validateRemoteUrl } from "@/lib/remotes";
import { RemoteUrlField } from "./RemoteUrlField";
import { RemoteValidityLine } from "./RemoteValidityLine";

const LABEL = "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-neutral-500";

/** "Add remote" affordance: a dashed button that expands to a name + URL form
 * with live validation, then calls `onAdd`. Collapses only after a *successful*
 * add — on failure the form stays open with the user's input. */
export const AddRemoteForm = ({
  busy,
  onAdd,
}: {
  busy: boolean;
  /** Resolves true when the remote was added; false leaves the form open. */
  onAdd: (name: string, url: string) => Promise<boolean>;
}) => {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const nameTrimmed = name.trim();
  const nameValid = isValidRemoteName(nameTrimmed);
  const urlValidity = validateRemoteUrl(url);
  const canSave = urlValidity.ok && nameValid && !busy;

  const reset = () => {
    setOpen(false);
    setName("");
    setUrl("");
  };

  const submit = async () => {
    if (!canSave) return;
    if (await onAdd(nameTrimmed, url.trim())) reset();
  };

  if (!open) {
    return (
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(true)}
        className="flex h-11 items-center justify-center gap-2 rounded-xl border border-dashed border-black/15 text-[13.5px] font-medium text-neutral-500 hover:border-black/25 hover:text-neutral-700 disabled:opacity-40 dark:border-white/15 dark:text-neutral-400 dark:hover:border-white/25 dark:hover:text-neutral-200"
      >
        <PlusIcon className="h-4 w-4" />
        Add remote
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-[color:var(--accent)]/40 bg-white p-4 shadow-sm dark:bg-neutral-800">
      <div className="grid grid-cols-[160px_1fr] gap-3">
        <label className="block">
          <span className={LABEL}>Name</span>
          <input
            type="text"
            value={name}
            spellCheck={false}
            autoFocus
            placeholder="origin"
            aria-label="Remote name"
            aria-invalid={nameTrimmed.length > 0 && !nameValid}
            onChange={(e) => setName(e.target.value)}
            className={`h-10 w-full rounded-lg border bg-black/[0.02] px-3 font-mono text-[13px] text-neutral-900 outline-none focus:ring-2 focus:ring-[var(--accent-soft)] dark:bg-white/[0.04] dark:text-white ${
              nameTrimmed.length > 0 && !nameValid
                ? "border-rose-400/70 focus:border-rose-500"
                : "border-black/10 focus:border-[color:var(--accent)] dark:border-white/10"
            }`}
          />
        </label>
        <label className="block" htmlFor="add-remote-url">
          <span className={LABEL}>URL</span>
          <RemoteUrlField id="add-remote-url" value={url} onChange={setUrl} invalid={urlValidity.level === "bad"} ariaLabel="Remote URL" />
        </label>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-3">
        {nameTrimmed.length > 0 && !nameValid ? (
          <span className="text-[12.5px] font-medium text-rose-600 dark:text-rose-400">
            Remote name: letters or digits, then only . _ or -
          </span>
        ) : (
          <RemoteValidityLine validity={urlValidity} />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="h-9 rounded-lg border border-black/10 px-3.5 text-[13px] font-semibold text-neutral-600 hover:bg-black/[0.04] dark:border-white/[0.14] dark:text-neutral-300 dark:hover:bg-white/[0.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={submit}
            className={`h-9 rounded-lg bg-[var(--accent)] px-4 text-[13px] font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
          >
            Add remote
          </button>
        </div>
      </div>
    </div>
  );
};
