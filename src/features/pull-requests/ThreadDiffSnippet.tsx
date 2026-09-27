import { parseThreadDiffSnippet, type SnippetKind } from "./parseThreadDiffSnippet";
import { MONO_FONT } from "@/lib/ui";
import { DIFF_ADD, DIFF_ADD_BG, DIFF_DEL, DIFF_DEL_BG } from "@/lib/diffTones";

// Same add/del tints as UnifiedDiff / DiffBody (`lib/diffTones`).
const ADD_BG = DIFF_ADD_BG;
const DEL_BG = DIFF_DEL_BG;
const ADD_RAIL = DIFF_ADD;
const DEL_RAIL = DIFF_DEL;

function lineStyle(kind: SnippetKind): { background: string; borderLeft: string } {
  if (kind === "add") return { background: ADD_BG, borderLeft: `3px solid ${ADD_RAIL}` };
  if (kind === "del") return { background: DEL_BG, borderLeft: `3px solid ${DEL_RAIL}` };
  if (kind === "header") {
    return { background: "rgba(139,92,246,0.08)", borderLeft: "3px solid transparent" };
  }
  return { background: "transparent", borderLeft: "3px solid transparent" };
}

function sign(kind: SnippetKind): string {
  if (kind === "add") return "+";
  if (kind === "del") return "−";
  return "";
}

export function ThreadDiffSnippet({ diffHunk }: { diffHunk: string | null }) {
  const lines = parseThreadDiffSnippet(diffHunk);
  if (lines.length === 0) return null;

  return (
    <div
      data-testid="thread-diff-snippet"
      className="mx-3.5 mb-2 overflow-x-auto rounded-md border border-black/10 dark:border-white/10"
    >
      {lines.map((line, i) => {
        const style = lineStyle(line.kind);
        const glyph = sign(line.kind);
        return (
          <div
            key={i}
            className={
              line.kind === "header"
                ? "flex min-h-[22px] items-center px-2 font-mono text-[11.5px] text-violet-600 dark:text-violet-300"
                : "flex min-h-[22px] items-center px-2 font-mono text-[12px] text-neutral-800 dark:text-neutral-100"
            }
            style={{
              fontFamily: MONO_FONT,
              lineHeight: "22px",
              background: style.background,
              borderLeft: style.borderLeft,
            }}
          >
            <span
              className="w-3.5 flex-none select-none"
              style={{ color: line.kind === "add" ? ADD_RAIL : line.kind === "del" ? DEL_RAIL : undefined }}
            >
              {glyph}
            </span>
            <span className="whitespace-pre">{line.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}
