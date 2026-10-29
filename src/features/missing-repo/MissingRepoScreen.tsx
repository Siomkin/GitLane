// The dedicated state for a tab whose repository path no longer resolves
// (GL-108), shown in place of the workspace — never the raw libgit2 error on
// the global bar. The recovery actions map to the real cases: Remove (the
// repo is gone for good), Retry (it lives on an external volume that wasn't
// mounted), Initialize as git repo (the folder is fine, it just lost its
// `.git` — GL-153, `notARepository` only), Locate… (it moved). A repository
// opened over SSH whose host can't be reached is `disconnected`: Reconnect
// (Retry) and Remove only, since the folder itself is fine (remote-ssh-repos).

import { FolderIcon, PlusIcon, RefreshIcon, WarningIcon } from "@/components/ui/icons";
import { remoteHost, remoteOrigin, repoLabel } from "@/lib/paths";
import { remoteSessionOf, useRemoteSessions } from "@/store/remoteSessions";
import { useRepo } from "@/store/repo";
import { useUi } from "@/store/ui";

const secondaryButton =
  "h-10 rounded-xl border border-black/10 px-4 text-[13.5px] font-medium text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5";

export const MissingRepoScreen = () => {
  const missing = useRepo((state) => state.missingRepo);
  const loadRepo = useRepo((state) => state.loadRepo);
  const closeRepo = useRepo((state) => state.closeRepo);
  const locateMissingRepo = useRepo((state) => state.locateMissingRepo);
  const initMissingRepo = useRepo((state) => state.initMissingRepo);
  const initMissingRepoRunning = useRepo((state) => state.initMissingRepoRunning);
  const requestConfirm = useUi((state) => state.requestConfirm);
  const session = useRemoteSessions(remoteSessionOf(missing ? remoteOrigin(missing.path) : ""));
  if (!missing) return null;

  const name = repoLabel(missing.path);
  const disconnected = missing.kind === "disconnected";
  const host = disconnected ? remoteHost(missing.path) : "";
  const message = disconnected
    ? (session?.error?.message ?? `GitLane lost its connection to ${host}. The repository on the server is unchanged.`)
    : missing.kind === "notARepository"
      ? "The folder still exists, but it no longer contains a git repository."
      : `${name} may have been moved or deleted — or it lives on a volume that isn't mounted right now.`;
  const title = disconnected
    ? `Can't reach ${host}`
    : missing.kind === "notARepository"
      ? "This folder is no longer a repository"
      : "This repository can't be found";

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center px-8">
        <div className="w-full max-w-[520px] text-center">
          <div className="mx-auto mb-6 grid h-14 w-14 place-items-center rounded-2xl bg-amber-500/15">
            <WarningIcon className="h-7 w-7 text-amber-500" />
          </div>
          <div className="text-[18px] font-semibold text-neutral-900 dark:text-neutral-50">
            {title}
          </div>
          <div className="mt-2 text-[14px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {message}
          </div>

          <div className="mx-auto mt-5 max-w-[440px] break-all rounded-xl border border-black/5 bg-black/[0.03] px-4 py-3 text-left font-mono text-[12px] leading-relaxed text-neutral-500 dark:border-white/10 dark:bg-white/5 dark:text-neutral-400">
            {missing.path}
          </div>

          <div className="mt-7 flex items-center justify-center gap-2.5">
            <button type="button" onClick={() => void closeRepo(missing.path)} className={secondaryButton}>
              Remove
            </button>
            {disconnected ? (
              <button type="button"
                onClick={() => void loadRepo(missing.path)}
                className="flex h-10 items-center gap-2 rounded-xl bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white shadow-sm hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900"
              >
                <RefreshIcon className="h-4 w-4" />
                Reconnect
              </button>
            ) : (
              <button type="button"
                onClick={() => void loadRepo(missing.path)}
                className={`flex items-center gap-2 ${secondaryButton}`}
              >
                <RefreshIcon className="h-4 w-4" />
                Retry
              </button>
            )}
            {missing.kind === "notARepository" && (
              <button type="button"
                disabled={initMissingRepoRunning}
                onClick={() =>
                  requestConfirm({
                    title: "Initialize as git repo?",
                    message:
                      "A new git repository will be created in this folder. Your files stay as they are, but any commit history lost with the old .git directory cannot be recovered.",
                    warnings: ["This cannot restore branches, remotes, or past commits."],
                    confirmLabel: "Initialize",
                    onConfirm: () => void initMissingRepo(),
                  })
                }
                className={`flex items-center gap-2 ${secondaryButton} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <PlusIcon className="h-4 w-4" />
                {initMissingRepoRunning ? "Initializing…" : "Initialize as git repo"}
              </button>
            )}
            {!disconnected && (
              <button type="button"
                onClick={() => void locateMissingRepo()}
                className="flex h-10 items-center gap-2 rounded-xl bg-[color:var(--accent)] px-5 text-[13.5px] font-semibold text-white shadow-sm hover:brightness-110"
              >
                <FolderIcon className="h-4 w-4" />
                Locate…
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
};
