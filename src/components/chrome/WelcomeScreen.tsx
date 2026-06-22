import { repoLabel } from "../../lib/paths";
import { useRepo } from "../../store/repo";
import { ClockIcon, FolderIcon } from "../ui/icons";

export function WelcomeScreen({ onOpen }: { onOpen: () => void }) {
  const openPaths = useRepo((state) => state.openPaths);
  const loadRepo = useRepo((state) => state.loadRepo);
  const recents = [...openPaths].reverse().slice(0, 6);

  return (
    <main className="grid min-h-0 flex-1 place-items-center p-10">
      <section className="flex w-full max-w-[440px] flex-col items-center gap-6 text-center">
        <span className="grid h-16 w-16 place-items-center rounded-[18px] bg-linear-to-br from-[#5b8def] via-[#2f9e7e] to-[#e0843b] text-2xl font-extrabold text-white shadow-lg">
          GL
        </span>
        <div className="grid gap-2">
          <h1 className="text-3xl font-extrabold text-neutral-800 dark:text-neutral-100">GitLane</h1>
          <p className="mx-auto max-w-[340px] leading-normal text-neutral-500 dark:text-neutral-400">
            Visual history, branches, diffs, and commits in one desktop workflow.
          </p>
        </div>
        <button
          className="h-10 cursor-pointer rounded-lg bg-[var(--accent)] px-6 text-[15px] font-medium text-white transition hover:brightness-110"
          onClick={onOpen}
        >
          Open a repository
        </button>

        {recents.length > 0 && (
          <div className="mt-2 w-full text-left">
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-bold uppercase tracking-[0.06em] text-neutral-400">
              <ClockIcon className="h-3 w-3" />
              Recent
            </div>
            <div className="grid gap-1">
              {recents.map((path) => (
                <button
                  key={path}
                  className="flex items-center gap-2.5 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 text-left hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.04] dark:hover:bg-white/5"
                  onClick={() => loadRepo(path)}
                  title={path}
                >
                  <FolderIcon className="h-4 w-4 shrink-0 text-[color:var(--accent)]" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
                      {repoLabel(path)}
                    </span>
                    <span className="block truncate text-[11px] text-neutral-400">{path}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
