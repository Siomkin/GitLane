// Pure prompt/answer plumbing for the AI conflict resolution (no React, no IPC).
//
// The ACP client rejects every write tool (`acp/session.rs`), so the agent never
// edits the worktree itself: it is asked for the resolved file bodies and GitLane
// performs the write through the same `resolveConflictFile` path the manual
// editor uses. That keeps one writer, and keeps the agent's answer reviewable
// before it lands.
//
// One prompt carries every file of a resolve request — one file or "Resolve
// all" — so the agent sees the whole set in one session. Files are delimited by
// sentinel lines, not code fences: Markdown bodies carry their own fences, and
// back-to-back fenced files cannot be split reliably.
//
// The agent gets each whole file but answers with only the replacement for each
// numbered conflict: echoing a large file back took minutes of output for a
// one-line conflict. GitLane rebuilds the file from those replacements; a reply
// that is a whole file anyway is still accepted.

import {
  conflictRegionCount,
  endsWithNewline,
  hasMalformedHunk,
  parseConflict,
} from "@/features/conflicts/conflictModel";

export interface ResolveTarget {
  path: string;
  /** Worktree copy of the file, conflict markers included. */
  content: string;
  /** Optional free-text instruction from the user ("keep our logging", …). */
  note: string;
}

const open = (path: string) => `=== FILE: ${path} ===`;
const CLOSE = "=== END FILE ===";
const hunkOpen = (n: number | string) => `=== CONFLICT ${n} ===`;
const HUNK_CLOSE = "=== END CONFLICT ===";

const isOursMarker = (line: string) => line.startsWith("<<<<<<<");

/** Label each conflict so the answer can name it: a `=== CONFLICT n ===` line
 * before every `<<<<<<<` marker, numbered from 1. Only files that pass
 * {@link unsendableReason} are sent, so these labels and `parseConflict`'s
 * regions line up one to one. */
function numberConflicts(content: string): string {
  let n = 0;
  return content
    .split("\n")
    .map((line) => (isOursMarker(line) ? `${hunkOpen(++n)}\n${line}` : line))
    .join("\n");
}

/** Ask for the merged body of every target file in one answer. */
export function buildResolvePrompt(targets: ResolveTarget[]): string {
  const files = targets.flatMap(({ path, content, note }) => {
    const guidance = note.trim();
    return [
      ...(guidance ? [`The user says about \`${path}\`: ${guidance}`] : []),
      open(path),
      withTrailingNewline(numberConflicts(content)) + CLOSE,
      "",
    ];
  });
  return [
    targets.length === 1
      ? `Resolve the git merge conflict in \`${targets[0].path}\`.`
      : `Resolve the git merge conflicts in these ${targets.length} files. They come from the same merge — keep them consistent with each other.`,
    "Keep both sides' intent where they don't contradict; never leave conflict markers behind.",
    // GitLane's ACP gate refuses write tool calls, but an adapter that resolves
    // permissions inside its own CLI never asks us — and an agent that "helpfully"
    // edits the worktree takes the review step away from the user. Say it in the
    // prompt as well as enforcing it at the protocol.
    "Do NOT edit, create, or delete any file, and do not run git to stage or resolve anything.",
    "GitLane performs the write itself, after the user reviews your answer.",
    "",
    `The conflicted files follow. Each conflict is labelled by a \`${hunkOpen("<n>")}\` line just above its <<<<<<< marker; the label is not part of the file.`,
    "",
    ...files,
    "Do not repeat the files. Reply with only each conflict's replacement, in this format:",
    `a \`${open("<path>")}\` line; then for every numbered conflict in that file a \`${hunkOpen("<n>")}\` line, the raw lines that replace the whole conflict (from its <<<<<<< line through its >>>>>>> line, markers excluded; no code fence; nothing when the conflict resolves to no lines), and a \`${HUNK_CLOSE}\` line; then a \`${CLOSE}\` line.`,
    "Answer every numbered conflict of every file. Nothing else.",
  ].join("\n");
}

// Only the <<<<<<< / >>>>>>> sides: a bare ======= line is a Markdown setext
// underline as often as a conflict marker, and a real conflict always has both.
const MARKERS = /^(<{7}|>{7})/m;
// A fence the agent added around a body, optionally after one line of prose.
const FENCED = /^(?:[^\n`]+\n)?```[^\n]*\n([\s\S]*\n)```\s*$/;
const OPEN = /^=== FILE: (.+) ===\s*$/;

export type FileAnswer = { text: string } | { error: string };

const HUNK = /^=== CONFLICT (\d+) ===\s*$/;

/** Split an agent answer into one result per requested path.
 *
 * Blocks are matched by exact path at line start, never by position; a block
 * for a path nobody asked for is ignored, and a requested path with no block
 * gets its own error. A block holding `=== CONFLICT n ===` sections is rebuilt
 * into the whole file from the source; any other block is taken as the whole
 * file. Either way the result must hold no conflict markers. `sources` lets a
 * whole-file body the agent fenced anyway be unwrapped — only when the original
 * file has no fence line of its own.
 *
 * Lines are split on `\n` only, so a CRLF body keeps its `\r`s and still lines
 * up with its CRLF source. A one-file request whose answer has no file sentinel
 * at all (bare conflict sections, or a bare or fenced file, as adapters
 * sometimes reply) is taken as that file's block. */
export function splitResolvedAnswer(
  answer: string,
  sources: Record<string, string>,
): Record<string, FileAnswer> {
  const paths = Object.keys(sources);
  const lines = answer.split("\n");
  if (paths.length === 1 && !lines.some((line) => OPEN.test(line))) {
    const [path] = paths;
    return {
      [path]: lines.some((line) => HUNK.test(line))
        ? rebuild(lines, sources[path])
        : checkBody(answer.trim(), sources[path]),
    };
  }
  const bodies = new Map<string, string[]>();
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const opened = OPEN.exec(line);
    if (opened) {
      // Sent files never hold sentinel lines, so a start line inside an open
      // block means the agent dropped its end line: discard that broken block.
      current = opened[1].trim();
      buf = [];
    } else if (current !== null && line.trim() === CLOSE) {
      if (current in sources && !bodies.has(current)) bodies.set(current, buf);
      current = null;
    } else if (current !== null) {
      buf.push(line);
    }
  }
  const out: Record<string, FileAnswer> = {};
  for (const path of paths) {
    const body = bodies.get(path);
    out[path] =
      body === undefined
        ? { error: "The agent didn't return this file." }
        : body.some((line) => HUNK.test(line))
          ? rebuild(body, sources[path])
          : // Every body line ended in a newline, including a final blank one.
            checkBody(body.map((l) => l + "\n").join(""), sources[path]);
  }
  return out;
}

/** Put each `=== CONFLICT n ===` section of `lines` in place of conflict n of
 * `source`, keeping every line outside the conflicts as it was. */
function rebuild(lines: string[], source: string): FileAnswer {
  const hunks = new Map<number, string[]>();
  let current: number | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const opened = HUNK.exec(line);
    if (opened) {
      current = Number(opened[1]);
      buf = [];
    } else if (current !== null && line.trim() === HUNK_CLOSE) {
      if (!hunks.has(current)) hunks.set(current, buf);
      current = null;
    } else if (current !== null) {
      buf.push(line);
    }
  }
  const refused = unsendableReason(source);
  if (refused) return { error: refused };
  let n = 0;
  const out: string[] = [];
  for (const region of parseConflict(source)) {
    if (region.kind === "ctx") {
      out.push(...region.lines);
      continue;
    }
    const hunk = hunks.get(++n);
    if (!hunk) return { error: "The agent didn't resolve every conflict in this file." };
    const sides = [...region.ours, ...region.theirs];
    // Match the conflict's own line endings, whatever the agent's lines carry.
    const crlf = sides.length > 0 ? sides.some((line) => line.endsWith("\r")) : source.includes("\r\n");
    out.push(...unfence(hunk, sides).map((line) => line.replace(/\r$/, "") + (crlf ? "\r" : "")));
  }
  if (out.length === 0) return { error: "The agent returned no file content." };
  const text = out.join("\n") + (endsWithNewline(source) ? "\n" : "");
  if (MARKERS.test(text))
    return { error: "The agent left conflict markers in the file — resolve it by hand." };
  return { text };
}

/** A replacement the agent wrapped in a code fence anyway, unwrapped — unless
 * the conflict's own sides hold a fence line, when it may be the file's own. */
function unfence(hunk: string[], sides: string[]): string[] {
  const fence = (line: string) => /^```/.test(line);
  const last = hunk[hunk.length - 1];
  if (hunk.length < 2 || !fence(hunk[0]) || last?.trim() !== "```" || sides.some(fence)) return hunk;
  return hunk.slice(1, -1);
}

/** Why a conflicted text file must not go to the agent, or `null` when it can:
 * a sentinel line would make the prompt ambiguous, incomplete markers have no
 * extent to replace, and a literal `<<<<<<<` line inside a side would shift the
 * conflict numbers so answers land in the wrong conflicts. */
export function unsendableReason(content: string): string | null {
  if (holdsSentinel(content)) return SENTINEL_IN_FILE;
  const regions = parseConflict(content);
  if (hasMalformedHunk(regions)) return "This file's conflict markers are incomplete — resolve it by hand.";
  if (content.split("\n").filter(isOursMarker).length !== conflictRegionCount(regions))
    return "This file's conflict markers are ambiguous — resolve it by hand.";
  return null;
}

/** A file that itself holds a sentinel line would make the prompt (and its
 * answer block) ambiguous, so it is never sent. */
export const holdsSentinel = (content: string) =>
  /^=== (FILE: .+|END FILE|CONFLICT \d+|END CONFLICT) ===\s*$/m.test(content);

export const SENTINEL_IN_FILE = "This file can't be sent to the agent safely — resolve it by hand.";

function checkBody(body: string, source: string): FileAnswer {
  // Unwrap only when the original has no fence line at all — otherwise the
  // fence may be the file's own (a conflict on line 1 hides a leading one).
  const fenced = /^```/m.test(source) ? null : FENCED.exec(withTrailingNewline(body));
  const text = withTrailingNewline(fenced ? fenced[1] : body);
  if (!text.trim()) return { error: "The agent returned no file content." };
  if (MARKERS.test(text))
    return { error: "The agent left conflict markers in the file — resolve it by hand." };
  return { text };
}

/** Bytes of conflicted content one request may send. The whole answer must fit
 * the backend's 1 MiB answer cap and 5-minute turn, and a resolved file is
 * usually smaller than its conflicted input, so this leaves headroom. */
// shortcut: an oversized set is refused, not batched; batch into several turns if big merges need AI help.
export const MAX_SWEEP_BYTES = 600 * 1024;

export const TOO_LARGE = "Too large for one pass — resolve files individually.";

export function sweepTooLarge(contents: string[]): boolean {
  const encoder = new TextEncoder();
  return contents.reduce((sum, text) => sum + encoder.encode(text).length, 0) > MAX_SWEEP_BYTES;
}

function withTrailingNewline(text: string): string {
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}
