import { useMemo } from "react";
import { CloseIcon, FileIcon, WarningIcon } from "../../components/ui/icons";
import { MONO_FONT } from "../../lib/ui";
import { useRepo } from "../../store/repo";
import { Tokens, numCell } from "../review/DiffBody";
import { formatBytes, splitLinesCapped, utf8Bytes } from "./format";

/** Upper bound on lines rendered at once. One DOM row + tokenizer pass per line
 * would freeze the webview on a file with hundreds of thousands of short lines
 * (well within the backend's 2 MiB byte cap). Beyond this we render the head and
 * show a notice; full-file scrolling is a virtualization follow-up (GL-212). */
const MAX_RENDER_LINES = 20_000;

/** Center pane: one repository file opened read-only from the Files tab. */
export function RepoFileWorkspace() {
  const fileView = useRepo((s) => s.fileView);
  const openRepoFile = useRepo((s) => s.openRepoFile);
  const closeRepoFile = useRepo((s) => s.closeRepoFile);

  // Split only the head that renders — a 2 MiB file of very short lines would
  // otherwise allocate ~1M strings up front just to slice 20k off.
  const { lines: shownLines, total: totalLines } = useMemo(
    () => splitLinesCapped(fileView?.content?.text ?? "", MAX_RENDER_LINES),
    [fileView?.content?.text],
  );

  if (!fileView) return null;
  const content = fileView.content;

  return (
    <section
      aria-label={`File ${fileView.path}`}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-black/5 bg-white shadow-sm dark:border-white/5 dark:bg-neutral-800"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-black/5 px-3 dark:border-white/5">
        <FileIcon path={fileView.path} size={16} />
        <span className="min-w-0 truncate font-mono text-[12.5px] text-neutral-700 dark:text-neutral-200">
          {fileView.path}
        </span>
        {content && !content.binary && (
          <span className="shrink-0 text-[11px] text-neutral-400">
            {totalLines.toLocaleString()} lines · {formatBytes(content.size)}
          </span>
        )}
        <button
          type="button"
          onClick={closeRepoFile}
          aria-label="Close file"
          className="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/5 dark:hover:text-neutral-200"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </header>

      {content?.truncated && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-amber-500/15 bg-amber-500/[0.08] px-3 text-[12px] text-amber-700 dark:text-amber-300">
          <WarningIcon className="h-3.5 w-3.5 shrink-0" />
          Large file — showing the first {formatBytes(utf8Bytes(content.text ?? ""))} of{" "}
          {formatBytes(content.size)}.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {fileView.loading ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="shim h-[18px] rounded bg-black/[0.05] dark:bg-white/[0.06]" />
            ))}
          </div>
        ) : fileView.error ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-neutral-400">
            <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">
              Couldn't read this file.
            </p>
            <p className="max-w-full truncate text-[12px]">{fileView.error}</p>
            <button
              type="button"
              onClick={() => void openRepoFile(fileView.path)}
              className="mt-1 h-8 rounded-lg bg-[color:var(--accent)] px-3.5 text-[12px] font-semibold text-white hover:brightness-110"
            >
              Retry
            </button>
          </div>
        ) : content?.binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center text-neutral-400">
            <FileIcon path={fileView.path} size={36} />
            <p className="text-[13px] font-medium text-neutral-600 dark:text-neutral-300">
              Binary file — no text preview.
            </p>
            <p className="font-mono text-[12px]">{formatBytes(content.size)}</p>
          </div>
        ) : (
          <div className="py-2 text-[12.5px] leading-[20px]" style={{ fontFamily: MONO_FONT }}>
            {shownLines.map((line, i) => (
              <div key={i} className="flex hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                <span className={numCell}>{i + 1}</span>
                <span className="min-w-0 flex-1 whitespace-pre pl-3 pr-4 text-neutral-700 dark:text-neutral-300">
                  <Tokens content={line} />
                </span>
              </div>
            ))}
            {totalLines > MAX_RENDER_LINES && (
              <div className="mx-3 mt-1 rounded-md bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
                Showing the first {MAX_RENDER_LINES.toLocaleString()} of{" "}
                {totalLines.toLocaleString()} lines.
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
