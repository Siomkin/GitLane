import { useEffect, useState } from "react";
import type { DirectoryEntry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/ui";
import { useRemoteSessions } from "@/store/remoteSessions";
import { ArrowLeftIcon, FolderIcon, RepoBookIcon } from "@/components/ui/icons";
import { childOf, crumbsOf, parentOf, pathProblem } from "./model";
import { fieldClass } from "./ConnectionForm";

type Listing =
  | { state: "loading" }
  | { state: "ready"; entries: DirectoryEntry[] }
  | { state: "error"; message: string };

/** Step two: browse folders on the connected host and pick a repository.
 * Folders open on click; repositories (a `.git` inside) open the repo. A typed
 * absolute path works too. */
export function FolderBrowser({
  origin,
  dir,
  onNavigate,
  onOpen,
}: {
  /** `ssh://[user@]host[:port]` of the connected host. */
  origin: string;
  dir: string;
  onNavigate: (dir: string) => void;
  /** Open the repository at this server path. */
  onOpen: (path: string) => void;
}) {
  const listDirectory = useRemoteSessions((s) => s.listDirectory);
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [typed, setTyped] = useState(dir);

  useEffect(() => {
    let live = true;
    setTyped(dir);
    setListing({ state: "loading" });
    listDirectory(origin + dir)
      .then((entries) => live && setListing({ state: "ready", entries }))
      .catch((e: unknown) =>
        live && setListing({ state: "error", message: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [origin, dir, listDirectory]);

  const typedProblem = pathProblem(typed.trim());

  return (
    <div className="mt-4 flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim() && !typedProblem) onNavigate(typed.trim());
        }}
      >
        <input
          aria-label="Folder on the server"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className={cn(fieldClass, "mt-0 font-mono text-[12.5px]")}
        />
        <button
          type="submit"
          disabled={!!typedProblem}
          className={cn("h-9 rounded-lg border border-black/10 px-3 text-[12.5px] disabled:opacity-45 dark:border-white/10", focusRing)}
        >
          Go
        </button>
      </form>
      {typedProblem && <div className="text-[12px] text-rose-500">{typedProblem}</div>}

      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-0.5 text-[12px] text-neutral-500">
        <button
          type="button"
          aria-label="Up one folder"
          disabled={dir === "/"}
          onClick={() => onNavigate(parentOf(dir))}
          className={cn("mr-1 grid h-6 w-6 place-items-center rounded hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/5", focusRing)}
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
        </button>
        {crumbsOf(dir).map((c, i) => (
          <span key={c.path} className="flex items-center">
            {i > 1 && <span className="px-0.5 text-neutral-400">/</span>}
            <button
              type="button"
              onClick={() => onNavigate(c.path)}
              className={cn("rounded px-1 hover:bg-black/5 dark:hover:bg-white/5", focusRing)}
            >
              {c.label}
            </button>
          </span>
        ))}
      </nav>

      <div className="h-64 overflow-y-auto rounded-lg border border-black/10 dark:border-white/10">
        {listing.state === "loading" && <div className="p-3 text-[12.5px] text-neutral-400">Loading…</div>}
        {listing.state === "error" && <div className="p-3 text-[12.5px] text-rose-500">{listing.message}</div>}
        {listing.state === "ready" && listing.entries.length === 0 && (
          <div className="p-3 text-[12.5px] text-neutral-400">No folders here.</div>
        )}
        {listing.state === "ready" && listing.entries.length > 0 && (
          <ul aria-label="Folders">
            {listing.entries.map((entry) => {
              const path = childOf(dir, entry.name);
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    disabled={!entry.readable}
                    onClick={() => (entry.isRepo ? onOpen(path) : onNavigate(path))}
                    title={entry.readable ? path : `${path} (no access)`}
                    className={cn(
                      "flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] text-neutral-700 hover:bg-black/5 disabled:opacity-45 dark:text-neutral-200 dark:hover:bg-white/5",
                      focusRing,
                    )}
                  >
                    {entry.isRepo ? (
                      <RepoBookIcon className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent)]" />
                    ) : (
                      <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                    )}
                    <span className="truncate">{entry.name}</span>
                    {entry.isRepo && (
                      <span className="ml-auto shrink-0 text-[11.5px] font-medium text-[color:var(--accent)]">Open</span>
                    )}
                    {!entry.readable && <span className="ml-auto shrink-0 text-[11.5px]">No access</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
