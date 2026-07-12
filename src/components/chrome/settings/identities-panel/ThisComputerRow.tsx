// The global git-config identity — "this computer" — shown at the top of the
// Identities tab. It's the default commit source: a repo with nothing pinned
// commits as this. Read-only by design: it belongs to `git config --global`,
// not to GitLane's stores — surfacing it completes the picture without GitLane
// taking ownership of it.

import type { RepoIdentity } from "@/store/accounts";
import { GitBranchIcon } from "@/components/ui/icons";

export function ThisComputerRow({ identity }: { identity: RepoIdentity | null }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-black/10 bg-black/[0.02] p-3 dark:border-white/10 dark:bg-white/[0.03]">
      <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] bg-black/[0.06] text-neutral-500 dark:bg-white/[0.08] dark:text-neutral-300">
        <GitBranchIcon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-semibold text-neutral-900 dark:text-white">Default git identity</span>
          <span className="grid h-[17px] place-items-center rounded bg-black/[0.05] px-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-500 dark:bg-white/[0.07] dark:text-neutral-400">
            Global config
          </span>
        </div>
        <div className="mt-0.5 truncate text-[12px] text-neutral-500 dark:text-neutral-400">
          {identity
            ? `${identity.name} · ${identity.email}`
            : "No identity set in global git config"}
        </div>
      </div>
      <span
        className="shrink-0 px-2.5 text-[11.5px] text-neutral-400 dark:text-neutral-500"
        title="This identity comes from your global git config (git config --global user.name / user.email) — edit it there. Repos with nothing pinned commit as this."
      >
        Managed by git
      </span>
    </div>
  );
}
