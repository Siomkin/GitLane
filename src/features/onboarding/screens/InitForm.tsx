import type { OnboardingApi } from "@/features/onboarding/flows/useOnboarding";
import { GITIGNORE_TEMPLATES, type GitignoreTemplate } from "@/features/onboarding/onboarding";
import { ChevronLeft, DocIcon, FolderGlyph, NewRepoIcon, PlusGlyph } from "@/features/onboarding/icons";
import { ChevronDownIcon } from "@/components/ui/icons";

/** The initialize-repository form: location, folder name, initial branch, and
 * the README + .gitignore starter options. */
export const InitForm = ({ ob }: { ob: OnboardingApi }) => {
  const inputCls =
    "h-11 w-full rounded-xl border border-black/10 bg-white px-3.5 font-mono text-[13.5px] text-neutral-800 shadow-sm outline-none focus:border-[color:var(--accent)] focus:ring-2 focus:ring-[color:var(--accent)]/40 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-100";

  return (
    <div className="flex min-h-full items-center justify-center px-8 py-10">
      <div className="w-full max-w-[640px]">
        <button
          type="button"
          onClick={ob.goHome}
          className="mb-6 flex items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </button>

        <div className="mb-7 flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-[var(--accent-soft)] text-[color:var(--accent)]">
            <NewRepoIcon className="h-6 w-6" />
          </span>
          <div>
            <div className="text-[20px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
              Initialize a repository
            </div>
            <div className="text-[13.5px] text-neutral-500 dark:text-neutral-400">
              Create an empty Git repo in a local folder.
            </div>
          </div>
        </div>

        <div className="mb-1.5 block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
          Location
        </div>
        <div className="flex gap-2">
          <div className="flex h-11 min-w-0 flex-1 items-center rounded-xl border border-black/10 bg-white px-3.5 font-mono text-[13px] text-neutral-700 shadow-sm dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200">
            <FolderGlyph className="mr-2 h-4 w-4 shrink-0 text-neutral-400" />
            {ob.initParent ? (
              <span className="truncate">
                {ob.initParent}/
                <span className="font-semibold text-[color:var(--accent)]">
                  {ob.initName || "new-repo"}
                </span>
              </span>
            ) : (
              <span className="truncate font-sans text-neutral-400">Choose a location…</span>
            )}
          </div>
          <button
            type="button"
            onClick={ob.browseInitParent}
            className="h-11 rounded-xl border border-black/10 bg-white px-4 text-[13px] font-medium text-neutral-700 shadow-sm hover:bg-black/[0.03] dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-white/[0.04]"
          >
            Browse…
          </button>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="init-folder-name" className="mb-1.5 block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              Folder name
            </label>
            <input
              id="init-folder-name"
              value={ob.initName}
              onChange={(e) => ob.setInitName(e.target.value)}
              spellCheck={false}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="init-branch-name" className="mb-1.5 block text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              Initial branch
            </label>
            <input
              id="init-branch-name"
              value={ob.initBranch}
              onChange={(e) => ob.setInitBranch(e.target.value)}
              spellCheck={false}
              className={inputCls}
            />
          </div>
        </div>

        <div className="mt-5 divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
          <button
            type="button"
            onClick={ob.toggleReadme}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-300">
              <DocIcon className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block text-[13.5px] font-medium text-neutral-800 dark:text-neutral-100">
                Add a README.md
              </span>
              <span className="block text-[12px] text-neutral-400 dark:text-neutral-500">
                Create a starter readme in the new repository.
              </span>
            </span>
            <span
              className={`h-5 w-9 rounded-full p-0.5 transition ${
                ob.initReadme ? "bg-[color:var(--accent)]" : "bg-black/15 dark:bg-white/15"
              }`}
            >
              <span
                className={`block h-4 w-4 rounded-full bg-white shadow transition ${
                  ob.initReadme ? "translate-x-4" : ""
                }`}
              />
            </span>
          </button>

          <div className="flex w-full items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-black/[0.04] text-neutral-500 dark:bg-white/[0.06] dark:text-neutral-300">
              <FolderGlyph className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block text-[13.5px] font-medium text-neutral-800 dark:text-neutral-100">
                .gitignore template
              </span>
              <span className="block text-[12px] text-neutral-400 dark:text-neutral-500">
                Optional starter ignore rules.
              </span>
            </span>
            <div className="relative">
              <select
                aria-label=".gitignore template"
                value={ob.initIgnore}
                onChange={(e) => ob.setInitIgnore(e.target.value as GitignoreTemplate)}
                className="h-8 appearance-none rounded-lg border border-black/10 bg-white pl-3 pr-7 text-[12.5px] font-medium text-neutral-600 dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {GITIGNORE_TEMPLATES.map((tpl) => (
                  <option key={tpl} value={tpl}>
                    {tpl}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            </div>
          </div>
        </div>

        {ob.initError && (
          <div className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3.5 py-2 text-[12.5px] text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            {ob.initError}
          </div>
        )}

        <div className="mt-8 flex items-center justify-end gap-2.5 border-t border-black/5 pt-5 dark:border-white/5">
          <button
            type="button"
            onClick={ob.goHome}
            className="h-10 rounded-xl px-4 text-[13.5px] font-medium text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={ob.startInit}
            disabled={!ob.canInit || ob.initBusy}
            className={`flex h-10 items-center gap-2 rounded-xl px-5 text-[13.5px] font-semibold text-white shadow-sm transition ${
              ob.canInit && !ob.initBusy
                ? "bg-[color:var(--accent)] hover:brightness-110"
                : "cursor-not-allowed bg-neutral-300 opacity-60 dark:bg-neutral-700"
            }`}
          >
            <PlusGlyph className="h-4 w-4" />
            {ob.initBusy ? "Creating…" : "Create repository"}
          </button>
        </div>
      </div>
    </div>
  );
};
