import { useEffect, useMemo, useState } from "react";
import { SearchIcon } from "../../components/ui/icons";
import { useRepo } from "../../store/repo";
import { buildFileRows, filterFiles } from "./tree";
import { DirRow, FileRow } from "./rows";

/** How many filter matches render before the "+N more" footer — an unbounded
 * match list (e.g. a one-letter query in a huge repo) would stall the panel. */
const MAX_FILTER_MATCHES = 300;

/** Right-panel Files tab: the repository file tree with a path filter. Rows
 * open a read-only view of the file in the center pane. */
export function FilesPanel() {
  const repoPath = useRepo((s) => s.summary?.path);
  const repoFiles = useRepo((s) => s.repoFiles);
  const loadRepoFiles = useRepo((s) => s.loadRepoFiles);
  const requestOpenRepoFile = useRepo((s) => s.requestOpenRepoFile);
  const openPath = useRepo((s) => s.fileView?.path ?? null);

  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // First activation loads the listing; afterwards `refresh` keeps it fresh.
  useEffect(() => {
    if (repoPath && !repoFiles) void loadRepoFiles();
  }, [repoPath, repoFiles, loadRepoFiles]);

  // The panel survives a repo switch in place — drop the previous repo's
  // expansion state and filter, which are meaningless against the new tree.
  useEffect(() => {
    setExpanded({});
    setQuery("");
  }, [repoPath]);

  const filesOrNull = repoFiles?.files;
  const files = useMemo(() => filesOrNull ?? [], [filesOrNull]);
  const filtering = query.trim() !== "";
  const matches = useMemo(() => filterFiles(files, query), [files, query]);
  const rows = useMemo(
    () => (filtering ? [] : buildFileRows(files, expanded)),
    [filtering, files, expanded],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-black/5 p-2 dark:border-white/5">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-black/[0.05] px-2.5 focus-within:ring-1 focus-within:ring-[color:var(--accent)] dark:bg-white/[0.06]">
          <SearchIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            aria-label="Filter repository files"
            className="w-full bg-transparent text-[12.5px] text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1">
        {repoFiles?.error ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <p className="text-[12.5px] text-neutral-500 dark:text-neutral-400">Couldn't list files.</p>
            <p className="max-w-full truncate text-[11.5px] text-neutral-400">{repoFiles.error}</p>
            <button
              type="button"
              onClick={() => void loadRepoFiles()}
              className="mt-1 h-7 rounded-lg bg-[color:var(--accent)] px-3 text-[11.5px] font-semibold text-white hover:brightness-110"
            >
              Retry
            </button>
          </div>
        ) : !repoFiles || (repoFiles.loading && files.length === 0) ? (
          <div className="space-y-1 p-2.5">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="shim h-[22px] rounded bg-black/[0.05] dark:bg-white/[0.06]" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <div className="grid h-full place-content-center px-6 text-center text-[12.5px] text-neutral-400">
            No files in this repository.
          </div>
        ) : filtering ? (
          matches.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-neutral-400">
              No files match “{query.trim()}”.
            </div>
          ) : (
            <>
              {matches.slice(0, MAX_FILTER_MATCHES).map((path) => (
                <FileRow
                  key={path}
                  path={path}
                  depth={0}
                  fullPath
                  active={path === openPath}
                  onOpen={() => requestOpenRepoFile(path)}
                />
              ))}
              {matches.length > MAX_FILTER_MATCHES && (
                <p className="px-3 py-2 text-[11.5px] text-neutral-400">
                  +{matches.length - MAX_FILTER_MATCHES} more — refine the filter.
                </p>
              )}
            </>
          )
        ) : (
          rows.map((row) =>
            row.kind === "dir" ? (
              <DirRow
                key={row.key}
                label={row.label}
                depth={row.depth}
                expanded={row.expanded}
                onToggle={() =>
                  setExpanded((prev) => ({ ...prev, [row.key]: !prev[row.key] }))
                }
              />
            ) : (
              <FileRow
                key={row.key}
                path={row.path}
                depth={row.depth}
                active={row.path === openPath}
                onOpen={() => requestOpenRepoFile(row.path)}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}
