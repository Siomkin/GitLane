// Stacked all-files review for a single oid (a commit or a stash commit): every
// changed file shown in one scroll with its unified diff. Used by "Review all"
// on a commit and by the stash viewer.

import { useEffect, useRef, useState } from "react";
import { api, type FileChange } from "../../lib/api";
import { basename, dirname } from "../../lib/paths";
import { useLazyDiffs } from "../../hooks/useLazyDiffs";
import { useRepo } from "../../store/repo";
import { useUi } from "../../store/ui";
import { FileIcon } from "@/components/ui/icons";
import { DiffTruncatedNotice, UnifiedDiffBody } from "./DiffBody";
import { HandToAgentBar } from "./comments";
import { StatusPill } from "@/components/ui/StatusBadge";

/** Changed-line count above which a file starts collapsed, so a lockfile-sized
 * diff doesn't mount thousands of rows (or get fetched) until asked for. */
const LARGE_DIFF_LINES = 500;

/** Lockfiles / generated artifacts: large, rarely the point of a review, so they
 * start collapsed regardless of size. */
const GENERATED_FILE =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|go\.sum|Gemfile\.lock|poetry\.lock)$|\.min\.(js|css)$|\.map$/i;

function startsCollapsed(file: FileChange): boolean {
  return file.add + file.del > LARGE_DIFF_LINES || GENERATED_FILE.test(file.path);
}

export function StackedReview() {
  const review = useUi((s) => s.stackedReview);
  const closeStackedReview = useUi((s) => s.closeStackedReview);
  const summary = useRepo((s) => s.summary);
  const selectedFile = useRepo((s) => s.selectedFile);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Files the reviewer chose to see in full after the backend truncated a large
  // diff. Their fetch re-keys (`path:full`) so the cache holds a distinct entry.
  const [fullFiles, setFullFiles] = useState<Set<string>>(new Set());
  const diffKeyFor = (p: string) => (fullFiles.has(p) ? `${p}:full` : p);
  // Per-file diff cache. Keyed by path, which is *not* content-stable across
  // commits, so we reset() on every oid/range change to drop the previous
  // commit's cache and invalidate its in-flight fetches.
  const { diffs, ensure, reset } = useLazyDiffs();

  // Section elements, keyed by path, so picking a file in the right-panel list
  // can scroll its diff into view (and expand it if it was collapsed).
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  const oid = review?.oid ?? null;
  const range = review?.range ?? null;
  const path = summary?.path ?? null;

  // Fetch the file list for this oid/range; reset the diff cache + collapse.
  useEffect(() => {
    if (!oid || !path) return;
    let cancelled = false;
    setListLoading(true);
    reset();
    setFullFiles(new Set());
    (async () => {
      try {
        // Range mode diffs base..head; otherwise it's a single commit/stash.
        const list = range
          ? await api.diffRange(path, range.base, range.head)
          : await api.commitFiles(path, oid);
        if (!cancelled) {
          setFiles(list);
          // Large/generated files start collapsed so they aren't fetched or
          // mounted until the reviewer opens them.
          setCollapsed(
            Object.fromEntries(list.filter(startsCollapsed).map((f) => [f.path, true])),
          );
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
          setCollapsed({});
        }
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [oid, range, path, reset]);

  // Lazily fetch the diff of each *open* file once the list is in (bounded
  // concurrency lives in useLazyDiffs). Collapsed large/generated files are not
  // fetched until expanded — re-running on `collapsed` picks them up then.
  useEffect(() => {
    if (!path || !oid) return;
    ensure(
      files
        .filter((f) => !collapsed[f.path])
        .map((f) => {
          const full = fullFiles.has(f.path);
          return {
            key: diffKeyFor(f.path),
            fetch: () =>
              range
                ? api.diffRangeFile(path, range.base, range.head, f.path, full)
                : api.commitFileDiff(path, oid, f.path, full),
          };
        }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- diffKeyFor derives from fullFiles
  }, [files, collapsed, fullFiles, path, oid, range, ensure]);

  // Only the file list gates the view; each file's diff then streams into its
  // own section, so the first files are reviewable before the slowest resolves.
  const loading = listLoading;

  // Clicking a file in the right-panel changed-files list selects it; scroll
  // that section into view here and expand it. Depends on `files` so it also
  // fires once the diffs finish loading if a file was picked while loading.
  useEffect(() => {
    if (selectedFile?.source !== "commit") return;
    const target = selectedFile.path;
    const el = sectionRefs.current[target];
    if (!el) return;
    setCollapsed((c) => (c[target] ? { ...c, [target]: false } : c));
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedFile?.path, selectedFile?.source, files]);

  if (!review) return null;

  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-white dark:bg-neutral-800 shadow-sm">
      <div className="flex h-12 flex-none items-center gap-3 border-b border-black/5 dark:border-white/5 px-4">
        <span className="truncate text-[14px] font-semibold text-neutral-800 dark:text-neutral-100">{review.title}</span>
        <button
          className="ml-auto flex flex-none items-center gap-1 h-8 px-2.5 rounded-lg border border-black/10 dark:border-white/10 text-[12px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
          onClick={closeStackedReview}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
            <path d="m15 18-6-6 6-6" />
          </svg>
          Graph
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-white dark:bg-neutral-800">
        {loading ? (
          <div className="grid h-full place-content-center text-sm text-neutral-400">Loading diffs…</div>
        ) : files.length === 0 ? (
          <div className="grid h-full place-content-center text-sm text-neutral-400">No changes.</div>
        ) : (
          files.map((file) => {
            const open = !collapsed[file.path];
            const diff = diffs[diffKeyFor(file.path)];
            const active = selectedFile?.source === "commit" && selectedFile.path === file.path;
            return (
              <section
                key={file.path}
                ref={(el) => {
                  sectionRefs.current[file.path] = el;
                }}
                className="border-b border-black/5 dark:border-white/5"
              >
                <button
                  className={`flex items-center gap-2 px-4 h-11 w-full sticky top-0 z-10 text-left backdrop-blur border-b border-black/5 dark:border-white/5 ${
                    active
                      ? "bg-[var(--accent-soft)]"
                      : "bg-white/95 dark:bg-neutral-800/95"
                  }`}
                  onClick={() => setCollapsed((c) => ({ ...c, [file.path]: !c[file.path] }))}
                >
                  <span className="w-3 flex-none text-[10px] text-neutral-400">{open ? "▾" : "▸"}</span>
                  <span className="text-[color:var(--accent)]">
                    <FileIcon path={file.path} size={20} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    <span className="text-neutral-400">{dirname(file.path)}</span>
                    <strong className="font-semibold text-neutral-800 dark:text-neutral-100">{basename(file.path)}</strong>
                  </span>
                  <StatusPill status={file.status} />
                  <span className="font-mono text-[11px] text-[color:var(--accent)]">+{file.add}</span>
                  <span className="font-mono text-[11px] text-rose-500">−{file.del}</span>
                </button>
                {open && (
                  <div className="bg-white dark:bg-neutral-800">
                    {diff === undefined ? (
                      <div className="px-4 py-3 text-xs text-neutral-400">Loading diff…</div>
                    ) : diff && !diff.binary ? (
                      <>
                        <UnifiedDiffBody hunks={diff.hunks} file={file.path} />
                        {diff.truncated && (
                          <DiffTruncatedNotice
                            onShowFull={() =>
                              setFullFiles((prev) => new Set(prev).add(file.path))
                            }
                          />
                        )}
                      </>
                    ) : (
                      <div className="px-4 py-3 text-xs text-neutral-400">
                        {diff === null ? "Couldn't load diff." : diff?.binary ? "Binary file" : "No visible diff."}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      <HandToAgentBar />
    </main>
  );
}
