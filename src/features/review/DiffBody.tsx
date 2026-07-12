// Shared highlighted diff rendering used by the single-file review and the
// stacked changes review. The unified view matches the design prototype: each
// hunk is a rounded card, changed lines stage from a hover button in the sign
// column, and a right-rail handle pins "local comments" (single line or a
// dragged range) that are later handed to an agent. The split view keeps its
// simpler two-pane layout.

import { memo, useMemo } from "react";
import type { DiffHunk, DiffLine } from "@/lib/api";
import { cn } from "@/lib/cn";
import { highlight, Language } from "@/lib/highlight";
import { MONO_FONT } from "@/lib/ui";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { CheckIcon, MinusIcon, PlusIcon } from "@/components/ui/icons";
import {
  buildLineMeta,
  CommentCard,
  CommentEditor,
  CommentHandle,
  useLineComments,
  type LineCommentsController,
  type LineRowComments,
} from "./comments";

export const MONO = MONO_FONT;

// Add/del tints + rails, shared by unified and split. Kept as the app's brand
// green/rose (consistent with the graph) rather than the mockup's emerald.
const ADD_BG = "rgba(46,158,98,0.11)";
const DEL_BG = "rgba(225,98,111,0.12)";
const ADD_RAIL = "#2e9e62";
const DEL_RAIL = "#e0626f";

export const numCell =
  "w-[42px] flex-none px-2 text-right text-neutral-400 dark:text-neutral-500 tabular-nums select-none";

export function Tokens({ content, lang = Language.Generic }: { content: string; lang?: Language }) {
  const dark = useResolvedTheme() === "dark";
  // Highlighting runs a global regex per call; memoize so a parent re-render
  // (or a sibling line's state change) doesn't re-tokenize this line. Diffs pass
  // no `lang` and keep the generic tokenizer (unchanged); the file viewer passes
  // the file's detected language to colour by type.
  const tokens = useMemo(() => highlight(content, dark, lang), [content, dark, lang]);
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

// ===========================================================================
// Unified + split views — flat hunk header, line staging, in-diff comments.
// ===========================================================================

/** A hunk's stage/unstage affordance. `mode` flips label + icon; `disabledReason`
 * (e.g. truncated/untracked) shows a disabled pill with an explanatory title. */
export type HunkStage = { mode: "stage" | "unstage"; onClick: () => void; disabledReason?: string | null };

/** A single changed line's stage/unstage affordance (the sign-column button). */
export type LineStage = { mode: "stage" | "unstage"; onClick: () => void };

/** Flat full-width hunk header bar: the @@ header, the changed-line count, and
 * (when staging is available) a Stage/Unstage hunk pill. */
export const HunkCardHeader = ({
  header,
  changed,
  stage,
}: {
  header: string;
  changed: number;
  stage?: HunkStage | null;
}) => {
  const disabled = !!stage?.disabledReason;
  return (
    <div className="group/hunk flex h-9 items-center gap-2 border-b border-violet-500/10 bg-violet-500/[0.06] px-3 dark:border-white/5 dark:bg-violet-400/[0.08]">
      <span
        className="min-w-0 flex-1 truncate font-mono text-[12px] text-violet-600 dark:text-violet-300"
        style={{ fontFamily: MONO }}
      >
        {header}
      </span>
      {stage && (
        <button
          type="button"
          disabled={disabled}
          title={stage.disabledReason ?? undefined}
          onClick={(e) => {
            e.stopPropagation();
            stage.onClick();
          }}
          className={cn(
            "flex h-7 flex-none items-center gap-1 rounded-lg px-2.5 text-[11.5px] font-semibold opacity-0 transition group-hover/hunk:opacity-100 focus:opacity-100",
            disabled
              ? "cursor-not-allowed border border-black/10 text-neutral-400 dark:border-white/10"
              : stage.mode === "unstage"
                ? "border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 text-[color:var(--accent)]"
                : "border border-black/10 text-neutral-600 hover:bg-black/5 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5",
          )}
        >
          {!disabled && stage.mode === "unstage" && <CheckIcon width={10} height={10} />}
          {disabled ? "Unavailable" : stage.mode === "unstage" ? "Unstage hunk" : "Stage hunk"}
        </button>
      )}
      <span className="flex-none text-[11px] text-neutral-500 dark:text-neutral-400">
        {changed} {changed === 1 ? "line" : "lines"}
        {stage?.mode === "unstage" ? " staged" : ""}
      </span>
    </div>
  );
};

/** The small hover icon button to stage/unstage one line. Overlaid on the sign
 * column in the unified view, and placed at the end of a changed half in the
 * split view — pass a `className` to position it. */
export const LineStageButton = ({ stage, className }: { stage: LineStage; className?: string }) => (
  <button
    type="button"
    title={stage.mode === "unstage" ? "Unstage line" : "Stage line"}
    aria-label={stage.mode === "unstage" ? "Unstage line" : "Stage line"}
    onClick={(e) => {
      e.stopPropagation();
      stage.onClick();
    }}
    className={cn(
      "grid h-4 w-4 flex-none place-items-center rounded-[4px] border border-black/25 bg-white text-[color:var(--accent)] opacity-0 transition hover:bg-[color:var(--accent)]/10 focus:opacity-100 group-hover/line:opacity-100 dark:border-white/30 dark:bg-neutral-800",
      className,
    )}
  >
    {stage.mode === "unstage" ? (
      <MinusIcon width={10} height={10} strokeWidth={3} />
    ) : (
      <PlusIcon width={10} height={10} strokeWidth={3} />
    )}
  </button>
);

// Memoized: `line` is a stable object from the cached FileDiff; the small option
// objects (stage/comments) change only when this row's state does, so unrelated
// re-renders of the diff body skip unchanged rows.
export const UnifiedLine = memo(function UnifiedLine({
  line,
  stage,
  comments,
  controller,
}: {
  line: DiffLine;
  stage?: LineStage | null;
  comments?: LineRowComments | null;
  controller?: LineCommentsController | null;
}) {
  const tone = line.kind;
  const selecting = !!comments?.selecting;
  const covered = !!comments?.covered;
  const sign = tone === "add" ? "+" : tone === "del" ? "−" : "";
  const signColor = tone === "add" ? ADD_RAIL : tone === "del" ? DEL_RAIL : undefined;
  const bg = selecting
    ? "var(--accent-soft)"
    : tone === "add"
      ? ADD_BG
      : tone === "del"
        ? DEL_BG
        : covered
          ? "rgba(120,120,120,0.06)"
          : "transparent";
  const rail = tone === "add" ? ADD_RAIL : tone === "del" ? DEL_RAIL : covered ? "rgba(120,120,120,0.5)" : "transparent";

  const grid = (
    <div
      className={cn(
        "grid grid-cols-[92px_minmax(0,1fr)_36px] items-center",
        tone === "ctx" && !covered && !selecting && "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
      )}
      style={{
        fontFamily: MONO,
        fontSize: "12.5px",
        lineHeight: "22px",
        minHeight: "22px",
        background: bg,
        borderLeft: `3px solid ${rail}`,
      }}
      onMouseEnter={comments?.onRowEnter}
    >
      <div className="grid grid-cols-[1fr_1fr_22px] items-center">
        <span className="select-none pr-1 text-right tabular-nums text-neutral-400 dark:text-neutral-500">
          {line.oldNo ?? ""}
        </span>
        <span className="select-none pr-1 text-right tabular-nums text-neutral-400 dark:text-neutral-500">
          {line.newNo ?? ""}
        </span>
        <span className="relative grid select-none place-items-center">
          <span
            className={cn(stage && "transition-opacity group-hover/line:opacity-0")}
            style={signColor ? { color: signColor } : undefined}
          >
            {sign}
          </span>
          {stage && <LineStageButton stage={stage} className="absolute inset-0 m-auto" />}
        </span>
      </div>
      <span className="overflow-hidden pl-2">
        <Tokens content={line.content} />
      </span>
      <span className="flex items-center justify-end pr-3">{comments ? <CommentHandle row={comments} /> : null}</span>
    </div>
  );

  const body = (
    <>
      {grid}
      {comments?.editHere && controller ? <CommentEditor scope={comments.scope} controller={controller} /> : null}
      {comments?.showCard ? (
        <CommentCard scope={comments.scope} body={comments.body} onEdit={comments.edit} onDelete={comments.remove} />
      ) : null}
    </>
  );

  return <div className="group/line">{body}</div>;
});

const countChanged = (hunk: DiffHunk) =>
  hunk.lines.reduce((n, line) => (line.kind === "ctx" ? n : n + 1), 0);

/** Full unified diff body for a file (all hunks), rendered as hunk cards. When
 * `file` and `surface` are given, each line gains the local-comment affordances
 * (the comment controller is scoped to this file + review surface). */
export function UnifiedDiffBody({
  hunks,
  file,
  surface,
}: {
  hunks: DiffHunk[];
  file?: string;
  surface?: string;
}) {
  const lines = useMemo(() => (file ? buildLineMeta(hunks) : []), [hunks, file]);
  const controller = useLineComments(surface ?? "", file ?? "", lines);
  let seq = -1;
  return (
    <div>
      {hunks.map((hunk, h) => (
        <div key={`${hunk.header}:${h}`}>
          <HunkCardHeader header={hunk.header} changed={countChanged(hunk)} />
          {hunk.lines.map((line, l) => {
            seq += 1;
            return (
              <UnifiedLine
                key={l}
                line={line}
                comments={file ? controller.rowFor(seq) : null}
                controller={file ? controller : null}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
