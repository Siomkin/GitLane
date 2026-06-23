// Shared highlighted diff rendering used by the single-file review and the
// stacked changes review. Matches the design prototype's unified diff: two
// line-number gutters, a sign column, a colored left border + tinted background
// per changed line, and client-side syntax highlighting.

import { memo, useMemo, useState } from "react";
import type { DiffHunk, DiffLine } from "../../lib/api";
import { cn } from "../../lib/cn";
import { highlight } from "../../lib/highlight";
import { modEnter } from "../../lib/platform";
import { MONO_FONT } from "../../lib/ui";
import { useUi } from "../../store/ui";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";

export const MONO = MONO_FONT;

export const numCell =
  "w-[42px] flex-none px-2 text-right text-neutral-400 dark:text-neutral-500 tabular-nums select-none";

export function Tokens({ content }: { content: string }) {
  const dark = useResolvedTheme() === "dark";
  // Highlighting runs a global regex per call; memoize so a parent re-render
  // (or a sibling line's state change) doesn't re-tokenize this line.
  const tokens = useMemo(() => highlight(content, dark), [content, dark]);
  if (tokens.length === 0) return <span className="whitespace-pre"> </span>;
  return (
    <span className="whitespace-pre">
      {tokens.map((tok, i) => (
        <span key={i} style={{ color: tok.color }}>
          {tok.text}
        </span>
      ))}
    </span>
  );
}

/** Footer shown under a diff the backend capped at the line limit, with an
 * explicit escape hatch to re-fetch the whole thing. */
export function DiffTruncatedNotice({
  onShowFull,
  loading,
}: {
  onShowFull: () => void;
  loading?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 border-t border-amber-300/50 bg-amber-50/80 px-4 py-2.5 text-xs text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/[0.06] dark:text-amber-300">
      <span>Large diff truncated for performance — only the first lines are shown.</span>
      <button
        type="button"
        onClick={onShowFull}
        disabled={loading}
        className="ml-auto flex-none rounded-md border border-amber-400/50 px-2.5 py-1 font-medium hover:bg-amber-100/70 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-amber-400/10"
      >
        {loading ? "Loading…" : "Show full diff"}
      </button>
    </div>
  );
}

export function HunkHeader({ header }: { header: string }) {
  return (
    <div
      className="px-4 py-1 bg-violet-500/[0.06] dark:bg-violet-400/[0.08] text-violet-500 dark:text-violet-300 font-mono text-[12px]"
      style={{ fontFamily: MONO, lineHeight: "20px" }}
    >
      {header}
    </div>
  );
}

// Memoized: `line` is a stable object from the cached FileDiff and `file` is a
// string, so an unrelated re-render of the diff body skips unchanged rows.
export const UnifiedLine = memo(function UnifiedLine({ line, file }: { line: DiffLine; file?: string }) {
  const tone = line.kind;
  const bg = tone === "add" ? "rgba(46,158,98,0.11)" : tone === "del" ? "rgba(225,98,111,0.12)" : "transparent";
  const gut = tone === "add" ? "#2e9e62" : tone === "del" ? "#e0626f" : "transparent";
  const sign = tone === "add" ? "+" : tone === "del" ? "−" : "";
  const signColor = tone === "add" ? "#2e9e62" : tone === "del" ? "#e0626f" : undefined;

  // A deletion belongs to the old (L) side; adds/context to the new (R) side.
  const side: "L" | "R" = tone === "del" ? "L" : "R";
  const lineNo = side === "L" ? line.oldNo : line.newNo;
  const notable = !!file && lineNo != null;

  const row = (
    <div
      className="flex items-start"
      style={{
        fontFamily: MONO,
        fontSize: "12.5px",
        lineHeight: "19px",
        minHeight: "19px",
        background: bg,
        borderLeft: `3px solid ${gut}`,
      }}
    >
      <span className={numCell}>{line.oldNo ?? ""}</span>
      <span className={numCell}>{line.newNo ?? ""}</span>
      <span
        className={cn("w-3 flex-none text-center", signColor == null && "text-neutral-400")}
        style={signColor ? { color: signColor } : undefined}
      >
        {sign}
      </span>
      <Tokens content={line.content} />
    </div>
  );

  if (!notable) return row;

  return (
    <div className="group/line relative">
      {row}
      <LineNotes file={file!} side={side} line={lineNo!} code={line.content} />
    </div>
  );
});

/** Full unified diff body for a file (all hunks). When `file` is given, each line
 * gains a hover affordance to pin a review note (the "message for agent" input). */
export function UnifiedDiffBody({ hunks, file }: { hunks: DiffHunk[]; file?: string }) {
  return (
    <>
      {hunks.map((hunk, index) => (
        <section key={`${hunk.header}:${index}`}>
          <HunkHeader header={hunk.header} />
          {hunk.lines.map((line, lineIndex) => (
            <UnifiedLine key={lineIndex} line={line} file={file} />
          ))}
        </section>
      ))}
    </>
  );
}

// Left padding that clears the two number gutters (42px each) + the sign column,
// so note cards align under the code rather than the line numbers.
const NOTE_INDENT = "ml-[92px] mr-3 max-w-[680px]";

/**
 * The per-line review-note affordance: a hover "+" pinned to the gutter that
 * opens an inline editor, plus the saved note card. State lives in `useUi`
 * (session-only); one note per file+side+line.
 */
function LineNotes({
  file,
  side,
  line,
  code,
}: {
  file: string;
  side: "L" | "R";
  line: number;
  code: string;
}) {
  const note = useUi((s) =>
    s.reviewNotes.find((n) => n.file === file && n.side === side && n.line === line),
  );
  const addReviewNote = useUi((s) => s.addReviewNote);
  const removeReviewNote = useUi((s) => s.removeReviewNote);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const lineRef = `${side}${line}`;

  const open = () => {
    setDraft(note?.body ?? "");
    setEditing(true);
  };
  const save = () => {
    const body = draft.trim();
    if (body) addReviewNote({ file, side, line, lineRef, code, body });
    setEditing(false);
  };

  return (
    <>
      {!editing && (
        // Anchored to the right edge of the line-number gutter (two 42px columns)
        // so the affordance sits over the line number, not in the empty far-left
        // cell. The wrapper ignores pointer events; only the button is clickable.
        <div className="pointer-events-none absolute left-0 top-0 z-10 flex h-[19px] w-[84px] items-center justify-end pr-1 opacity-0 transition group-hover/line:opacity-100">
          <button
            type="button"
            onClick={open}
            title={note ? "Edit note" : "Add note for agent"}
            className="pointer-events-auto grid h-[17px] w-[17px] place-items-center rounded-[5px] bg-[#3b7ff5] text-[12px] font-semibold leading-none text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)] hover:brightness-110"
          >
            {note ? "✎" : "+"}
          </button>
        </div>
      )}

      {editing ? (
        <div
          className={cn(
            "my-1.5 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-500/[0.06] p-3",
            NOTE_INDENT,
          )}
        >
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            placeholder={`Note for line ${lineRef}… (${modEnter} to save)`}
            rows={2}
            className="w-full resize-y bg-transparent text-[13px] text-neutral-700 dark:text-neutral-200 outline-none placeholder:text-neutral-400 font-sans"
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              onClick={() => setEditing(false)}
              className="rounded-md px-2.5 py-1 text-[12px] text-neutral-500 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!draft.trim()}
              className="rounded-md bg-[#3b7ff5] px-2.5 py-1 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-45"
            >
              Save note
            </button>
          </div>
        </div>
      ) : note ? (
        <div
          className={cn(
            "my-1.5 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50/70 dark:bg-rose-500/[0.06] p-3",
            NOTE_INDENT,
          )}
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="#3b7ff5" className="w-3.5 h-3.5">
              <path d="M12 2 22 12 12 22 2 12z" />
            </svg>
            <span className="text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">Note for agent</span>
            <span className="ml-auto text-[11px] text-neutral-400 font-mono">line {lineRef}</span>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words text-[13px] text-neutral-700 dark:text-neutral-200">
            {note.body}
          </div>
          <div className="mt-1.5 flex justify-end gap-3 text-[11.5px]">
            <button onClick={open} className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200">
              Edit
            </button>
            <button
              onClick={() => removeReviewNote(note.id)}
              className="text-rose-500 hover:text-rose-600"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
