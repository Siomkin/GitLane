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

export interface ResolveTarget {
  path: string;
  /** Worktree copy of the file, conflict markers included. */
  content: string;
  /** Optional free-text instruction from the user ("keep our logging", …). */
  note: string;
}

const open = (path: string) => `=== FILE: ${path} ===`;
const CLOSE = "=== END FILE ===";

/** Ask for the merged body of every target file in one answer. */
export function buildResolvePrompt(targets: ResolveTarget[]): string {
  const files = targets.flatMap(({ path, content, note }) => {
    const guidance = note.trim();
    return [
      ...(guidance ? [`The user says about \`${path}\`: ${guidance}`] : []),
      open(path),
      withTrailingNewline(content) + CLOSE,
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
    "The conflicted files:",
    "",
    ...files,
    `Reply with every resolved file in the same format: a \`${open("<path>")}\` line, the complete resolved file as raw text (no code fence), then a \`${CLOSE}\` line. Nothing else.`,
  ].join("\n");
}

// Only the <<<<<<< / >>>>>>> sides: a bare ======= line is a Markdown setext
// underline as often as a conflict marker, and a real conflict always has both.
const MARKERS = /^(<{7}|>{7})/m;
// A fence the agent added around a body, optionally after one line of prose.
const FENCED = /^(?:[^\n`]+\n)?```[^\n]*\n([\s\S]*\n)```\s*$/;
const OPEN = /^=== FILE: (.+) ===\s*$/;

export type FileAnswer = { text: string } | { error: string };

/** Split an agent answer into one result per requested path.
 *
 * Blocks are matched by exact path at line start, never by position; a block
 * for a path nobody asked for is ignored, and a requested path with no block
 * gets its own error. Each body then passes the same checks a single file
 * always had: not empty, no conflict markers left. `sources` lets a body the
 * agent fenced anyway be unwrapped — only when the original file has no fence
 * line of its own.
 *
 * Lines are split on `\n` only, so a CRLF body keeps its `\r`s and still lines
 * up with its CRLF source. A one-file request whose answer has no sentinel at
 * all (a bare or fenced file, as adapters sometimes reply) is taken as that
 * file's body. */
export function splitResolvedAnswer(
  answer: string,
  sources: Record<string, string>,
): Record<string, FileAnswer> {
  const paths = Object.keys(sources);
  const lines = answer.split("\n");
  if (paths.length === 1 && !lines.some((line) => OPEN.test(line))) {
    return { [paths[0]]: checkBody(answer.trim(), sources[paths[0]]) };
  }
  const bodies = new Map<string, string>();
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
      // Every body line ended in a newline, including a final blank one.
      if (current in sources && !bodies.has(current)) bodies.set(current, buf.map((l) => l + "\n").join(""));
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
        : checkBody(body, sources[path]);
  }
  return out;
}

/** A file that itself holds a sentinel line would make the prompt (and its
 * answer block) ambiguous, so it is never sent. */
export const holdsSentinel = (content: string) => /^=== (FILE: .+|END FILE) ===\s*$/m.test(content);

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
