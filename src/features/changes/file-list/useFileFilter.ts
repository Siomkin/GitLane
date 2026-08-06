import { useEffect, useState } from "react";
import type { FileChange } from "@/lib/api";
import { basename } from "@/lib/paths";

/** Files whose **name** contains `query` (case-insensitive). Deliberately not
 * the full path: a query matching a directory would otherwise pull in every
 * file under it, which reads as "the filter is broken" when the listed names
 * don't contain the query. An empty/blank query keeps the list intact. */
export function filterFilesByName(files: FileChange[], query: string): FileChange[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter((f) => basename(f.path).toLowerCase().includes(needle));
}

/** Reveal-on-demand filter for a changed-files list (design 3b): hidden until
 * the magnifier button opens it (⌘F is deliberately left to the history
 * search), matched as a case-insensitive substring of the file name — see
 * {@link filterFilesByName}. Closing (Esc / the ✕) clears the query.
 *
 * `resetKey` scopes the filter to one subject: when it changes (a different
 * commit is selected), the field closes and the query clears so a stale query
 * never silently filters the next commit's files. */
export function useFileFilter(files: FileChange[], resetKey?: string | null) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [resetKey]);

  // Esc closes wherever focus sits — the input's own handler only covers the
  // focused case, and after clicking a row focus has moved into the list.
  // Capture phase so no other handler can swallow the key first.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("keydown", onEsc, true);
    return () => document.removeEventListener("keydown", onEsc, true);
  }, [open]);

  const matchQuery = query.trim().toLowerCase();
  const filtered = filterFilesByName(files, matchQuery);

  return {
    open,
    openFilter: () => setOpen(true),
    close: () => {
      setOpen(false);
      setQuery("");
    },
    query,
    setQuery,
    matchQuery,
    filtered,
  };
}
