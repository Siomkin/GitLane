// The clone form: a validated remote-URL field, a one-line auth status (with
// opt-in manual credentials — CloneAuthStatus/CloneAuthOptions), and a
// destination chooser. Auth is resolved automatically (accounts, keychain,
// glab, system credentials); the form only asks when the user wants to
// override, so the first page is just "where from, where to".

import type { OnboardingApi } from "../../flows/useOnboarding";
import { AlertCircle, ChevronLeft, CheckSmall, CloneIcon, FolderGlyph } from "../../icons";
import { CloneAuthStatus } from "./CloneAuthStatus";

export const CloneForm = ({ ob }: { ob: OnboardingApi }) => {
  const { state, repo } = ob.url;
  const borderCls =
    state === "valid"
      ? "border-emerald-400 dark:border-emerald-500/60 focus:ring-emerald-400/40"
      : state === "invalid"
        ? "border-red-400 dark:border-red-500/60 focus:ring-red-400/40"
        : "border-black/10 dark:border-white/10 focus:border-[color:var(--accent)] focus:ring-[color:var(--accent)]/40";
  const cloneBtnCls = ob.canClone
    ? "bg-[color:var(--accent)] hover:brightness-110"
    : "cursor-not-allowed bg-neutral-300 opacity-60 dark:bg-neutral-700";

  return (
    <div className="flex min-h-full items-center justify-center px-8 py-10">
      <div className="w-full max-w-[640px]">
        <button
          onClick={ob.goHome}
          className="mb-6 flex items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>

        <div className="mb-7 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--accent-soft)] text-[color:var(--accent)]">
            <CloneIcon className="h-6 w-6" />
          </span>
          <div>
            <div className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Clone a repository
            </div>
            <div className="text-[13.5px] text-neutral-500 dark:text-neutral-400">
              Enter a Git URL and choose where to put it.
            </div>
          </div>
        </div>

        {/* URL field */}
        <label className="mb-1.5 block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
          Remote URL
        </label>
        <div className="relative">
          <input
            value={ob.cloneUrl}
            onChange={(e) => ob.setCloneUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            spellCheck={false}
            autoFocus
            className={`h-11 w-full rounded-xl border bg-white pl-3.5 pr-10 font-mono text-[13.5px] text-neutral-800 shadow-sm outline-none transition placeholder:font-sans placeholder:text-neutral-400 focus:ring-2 dark:bg-neutral-800 dark:text-neutral-100 ${borderCls}`}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2">
            {state === "valid" && <CheckSmall className="h-4 w-4 text-emerald-500" />}
            {state === "invalid" && <AlertCircle className="h-4 w-4 text-red-500" />}
          </span>
        </div>
        <div className="mt-1.5 min-h-4 text-[12px]">
          {state === "invalid" && (
            <span className="text-red-500">
              Enter a valid Git URL — https://, git@host:path, or ssh://
            </span>
          )}
          {state === "valid" && (
            <span className="text-neutral-400 dark:text-neutral-500">
              Looks good — detected{" "}
              <span className="font-medium text-neutral-600 dark:text-neutral-300">{repo}</span>
            </span>
          )}
        </div>

        {/* How this clone will authenticate (opt-in manual credentials). */}
        {state === "valid" && ob.cloneRemoteInfo.valid && <CloneAuthStatus ob={ob} />}

        {/* Destination */}
        <label className="mb-1.5 mt-5 block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
          Local destination
        </label>
        <div className="flex gap-2">
          <div className="flex h-11 min-w-0 flex-1 items-center rounded-xl border border-black/10 bg-white px-3.5 font-mono text-[13px] text-neutral-700 shadow-sm dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
            <FolderGlyph className="mr-2 h-4 w-4 shrink-0 text-neutral-400" />
            {ob.cloneParent ? (
              <div className="flex min-w-0 flex-1 items-center">
                <span className="truncate">{ob.cloneParent}/</span>
                <input
                  value={ob.cloneFolder}
                  onChange={(e) => ob.setCloneFolder(e.target.value)}
                  spellCheck={false}
                  aria-label="Destination folder name"
                  size={Math.min(Math.max(ob.cloneFolder.length, 1), 32)}
                  className="shrink-0 bg-transparent font-semibold text-[color:var(--accent)] outline-none"
                />
              </div>
            ) : (
              <span className="truncate font-sans text-neutral-400">Choose a location…</span>
            )}
          </div>
          <button
            onClick={ob.browseCloneParent}
            className="h-11 rounded-xl border border-black/10 bg-white px-4 text-[13px] font-medium text-neutral-700 shadow-sm hover:bg-black/[0.03] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-white/[0.04]"
          >
            Browse…
          </button>
        </div>
        <div className="mt-1.5 text-[12px]">
          {ob.cloneParent && !ob.cloneFolderValid ? (
            <span className="text-red-500">Enter a folder name — it can’t contain “/” or “\”.</span>
          ) : (
            <span className="text-neutral-400 dark:text-neutral-500">
              The repository will be cloned into a new folder here.
            </span>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 flex items-center justify-end gap-2.5 border-t border-black/5 pt-5 dark:border-white/5">
          <button
            onClick={ob.goHome}
            className="h-10 rounded-xl px-4 text-[13.5px] font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={() => ob.startClone()}
            disabled={!ob.canClone}
            className={`flex h-10 items-center gap-2 rounded-xl px-5 text-[13.5px] font-semibold text-white shadow-sm transition ${cloneBtnCls}`}
          >
            <CloneIcon className="h-4 w-4" strokeWidth={1.9} />
            Clone repository
          </button>
        </div>
      </div>
    </div>
  );
};
