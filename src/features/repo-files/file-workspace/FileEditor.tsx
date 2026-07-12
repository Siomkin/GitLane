import { memo, useDeferredValue, useEffect, useMemo, useRef } from "react";
import { WarningIcon } from "../../../components/ui/icons";
import { cn } from "../../../lib/cn";
import type { Language } from "../../../lib/highlight";
import { MONO_FONT } from "../../../lib/ui";
import { Tokens } from "../../review/DiffBody";
import { rulerMarksFrom } from "./changeMarks";
import { ChangeBar, OverviewRuler } from "./changeMarkers";
import { computeLineChangesText, countLines, LineChange, type LineChanges } from "./lineChanges";

/** The in-app edit surface: a transparent `<textarea>` laid over a syntax-
 * highlighted backdrop, with a scroll-synced line-number gutter — so editing
 * shows the same numbered, colour-by-language rows as the read-only Source view.
 * The textarea owns the caret, selection, and scrolling; the backdrop (built
 * from the same per-line `Tokens`) and the gutter are driven from its scroll
 * offset. ⌘S / Ctrl-S saves (bound to `window` only while mounted, so it doesn't
 * collide with other shortcuts once the viewer closes).
 *
 * Very large files (over the highlight cap) fall back to a plain textarea: one
 * DOM row per line for a huge buffer would jank on every keystroke.
 *
 * Known limitation: a `<textarea>` normalizes CRLF to LF, so saving a file that
 * was CRLF converts its line endings (a noisy whole-file diff). Acceptable for a
 * macOS-first, LF-dominant repo; revisit if Windows line endings become common. */

const LINE_H = 20; // px — must match the textarea's line-height exactly
const PAD_Y = 8; // px — vertical padding shared by textarea, backdrop, and gutter
/** Text box metrics shared verbatim by the textarea and the backdrop so their
 * glyphs land on the same pixels (any drift misaligns the highlight). */
const BOX = { fontFamily: MONO_FONT, fontSize: "12.5px", lineHeight: `${LINE_H}px`, tabSize: 2 } as const;
const CODE_PAD = `${PAD_Y}px 16px ${PAD_Y}px 12px`;

/** Above this line count the highlighted backdrop + gutter are dropped for a
 * plain textarea — matches the Source view's render cap. */
const HIGHLIGHT_MAX_LINES = 20_000;

/** One backdrop row. Memoized on its own text so a keystroke only re-tokenizes
 * the edited line, not every line in the file. */
const BackdropLine = memo(function BackdropLine({ content, lang }: { content: string; lang: Language }) {
  return (
    <div className="whitespace-pre" style={{ height: LINE_H, width: "max-content", minWidth: "100%" }}>
      <Tokens content={content} lang={lang} />
    </div>
  );
});

/** Width of the change-bar lane at the right edge of the gutter — numbers are
 * padded clear of it so a bar never overlaps a digit. */
const BAR_LANE = 11; // px

/** The line-number column, with a per-line uncommitted-change bar in a lane on
 * its right edge (added/modified) and a caret where baseline lines were deleted.
 * The far-right overview ruler mirrors these for whole-file navigation. */
const Gutter = memo(function Gutter({ count, changes }: { count: number; changes: LineChanges | null }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="relative" style={{ height: LINE_H, paddingRight: BAR_LANE }}>
          {i + 1}
          {changes && (
            <ChangeBar tag={changes.tags[i] ?? LineChange.None} deletedAbove={changes.deletedBefore.has(i)} />
          )}
        </div>
      ))}
      {changes?.deletedAtEnd && (
        <div className="relative" style={{ height: 0 }}>
          <ChangeBar tag={LineChange.None} deletedAbove />
        </div>
      )}
    </>
  );
});

export function FileEditor({
  draft,
  dirty,
  saving,
  error,
  lang,
  baseline,
  onChange,
  onSave,
}: {
  draft: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  lang: Language;
  /** Committed (HEAD) text for the uncommitted-change gutter markers; null =
   * nothing to diff against (untracked/binary/oversized). */
  baseline: string | null;
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, []);

  // Keep the latest dirty/saving + onSave in refs so the window handler can read
  // them without re-subscribing on every keystroke. Updated in an effect (not
  // during render) so render stays pure — a keydown only fires after commit, so
  // the refs are always current by the time it reads them.
  const canSave = useRef(false);
  const save = useRef(onSave);
  useEffect(() => {
    canSave.current = dirty && !saving;
    save.current = onSave;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
        // Only claim the shortcut when there's actually something to save.
        if (!canSave.current) return;
        e.preventDefault();
        save.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lineCount = useMemo(() => countLines(draft), [draft]);
  const highlighted = lineCount <= HIGHLIGHT_MAX_LINES;
  const lines = useMemo(() => (highlighted ? draft.split("\n") : []), [draft, highlighted]);
  const gutterWidth = `${Math.max(2, String(lineCount).length)}ch`;

  // Uncommitted-change markers vs the committed baseline. Deferred so the diff
  // runs at low priority and never delays a keystroke; computed straight from the
  // (deferred) draft text (counts lines before splitting, so a newline-dense file
  // can't allocate before the cap rejects it) and only when highlighting is on.
  const deferredDraft = useDeferredValue(draft);
  const changes = useMemo(
    () => (highlighted ? computeLineChangesText(baseline, deferredDraft) : null),
    [highlighted, baseline, deferredDraft],
  );
  // Ruler denominator comes from the SAME deferred snapshot as `changes`, so the
  // marks stay internally consistent while the deferred diff trails live typing.
  const deferredLineCount = useMemo(() => countLines(deferredDraft), [deferredDraft]);

  const rulerMarks = useMemo(() => rulerMarksFrom(changes, deferredLineCount), [changes, deferredLineCount]);

  // The textarea is the only scrollable/interactive layer; mirror its offset onto
  // the (overflow-hidden) backdrop and gutter imperatively so scrolling doesn't
  // trigger a React render.
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (backdropRef.current) {
      backdropRef.current.scrollTop = ta.scrollTop;
      backdropRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  // Scroll so the line at `fraction` of the file is centred in the viewport
  // (overview-ruler click-to-jump). Maps against the last 0-based line so a
  // bottom-edge click lands on the final line, not one past it.
  const jumpToFraction = (fraction: number) => {
    const ta = taRef.current;
    if (!ta) return;
    const targetLine = Math.round(fraction * Math.max(0, lineCount - 1));
    ta.scrollTop = Math.max(0, targetLine * LINE_H - ta.clientHeight / 2);
    // Setting scrollTop doesn't synchronously fire onScroll, so mirror the
    // offset onto the gutter/backdrop now (the scrollTop read is post-clamp).
    syncScroll();
    ta.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-rose-500/20 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
          <WarningIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {highlighted && (
          <div
            ref={gutterRef}
            aria-hidden
            className="shrink-0 select-none overflow-hidden border-r border-black/5 bg-black/[0.015] text-right tabular-nums text-neutral-400 dark:border-white/5 dark:bg-white/[0.02] dark:text-neutral-600"
            // No right padding: the change-bar lane sits flush against the code
            // edge; each row reserves `BAR_LANE` on its right so digits clear it.
            style={{ ...BOX, width: `calc(${gutterWidth} + 12px + ${BAR_LANE}px)`, padding: `${PAD_Y}px 0 ${PAD_Y}px 12px` }}
          >
            <Gutter count={lineCount} changes={changes} />
          </div>
        )}

        <div className="relative min-w-0 flex-1">
          {highlighted && (
            <pre
              ref={backdropRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden text-neutral-700 dark:text-neutral-300"
              style={{ ...BOX, padding: CODE_PAD }}
            >
              {lines.map((line, i) => (
                <BackdropLine key={i} content={line} lang={lang} />
              ))}
            </pre>
          )}

          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => onChange(e.target.value)}
            onScroll={syncScroll}
            // Freeze the buffer during the write so keystrokes can't outrace the
            // save and be lost when the saved draft is republished as the baseline.
            readOnly={saving}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            // `wrap="off"` (not just CSS) is what actually stops the textarea
            // wrapping, so long lines scroll horizontally in lockstep with the
            // no-wrap backdrop instead of drifting out of alignment.
            wrap="off"
            aria-label="File contents"
            className={cn(
              "absolute inset-0 resize-none overflow-auto border-0 bg-transparent caret-neutral-800 outline-none dark:caret-neutral-100",
              // Hide the textarea's own glyphs so the coloured backdrop shows
              // through; the caret and selection stay visible.
              highlighted ? "text-transparent" : "text-neutral-700 dark:text-neutral-200",
            )}
            style={{ ...BOX, padding: highlighted ? CODE_PAD : `${PAD_Y}px 12px`, whiteSpace: "pre" }}
          />
        </div>

        {highlighted && rulerMarks.length > 0 && <OverviewRuler marks={rulerMarks} onJump={jumpToFraction} />}
      </div>
    </div>
  );
}
