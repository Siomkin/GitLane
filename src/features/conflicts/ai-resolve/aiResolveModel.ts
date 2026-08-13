// Pure prompt/answer plumbing for the AI conflict resolution (no React, no IPC).
//
// The ACP client rejects every write tool (`acp/session.rs`), so the agent never
// edits the worktree itself: it is asked for the resolved file body and GitLane
// performs the write through the same `resolveConflictFile` path the manual
// editor uses. That keeps one writer, and keeps the agent's answer reviewable
// before it lands.

/** Ask for the merged file body of one conflicted file, plus whatever the user
 * wants to say about how it should be resolved. */
export function buildResolvePrompt({
  path,
  content,
  note,
}: {
  path: string;
  /** Worktree copy of the file, conflict markers included. */
  content: string;
  /** Optional free-text instruction from the user ("keep our logging", …). */
  note: string;
}): string {
  const guidance = note.trim();
  return [
    `Resolve the git merge conflict in \`${path}\`.`,
    guidance && `The user says: ${guidance}`,
    "Keep both sides' intent where they don't contradict; never leave conflict markers behind.",
    // GitLane's ACP gate refuses write tool calls, but an adapter that resolves
    // permissions inside its own CLI never asks us — and an agent that "helpfully"
    // edits the worktree takes the review step away from the user. Say it in the
    // prompt as well as enforcing it at the protocol.
    "Do NOT edit, create, or delete any file, and do not run git to stage or resolve anything.",
    "GitLane performs the write itself, after the user reviews your answer.",
    "",
    "The conflicted file:",
    "```",
    content,
    "```",
    "",
    "Reply with the complete resolved file in a single fenced code block, and nothing else.",
  ]
    .filter(Boolean)
    .join("\n");
}

const CLOSE_FENCE = /\n?```$/;
// Opening fence at column 0, optionally after one prose line that itself
// contains no fence. Anything else is a bare file (Markdown with its own
// ``` blocks) and must be kept as-is — a search-from-anywhere unwrap would
// discard the prose of a docs file that happens to end on a fence line.
const OUTER_FENCE = /^(?:[^\n`]+\n)?```[^\n]*\n/;

// Only the <<<<<<< / >>>>>>> sides: a bare ======= line is a Markdown setext
// underline as often as a conflict marker, and a real conflict always has both.
const MARKERS = /^(<{7}|>{7})/m;

/** The resolved file body out of an agent answer, or an error to show instead.
 *
 * Adapters wrap the file in a fence (asked for), sometimes with a line of prose
 * before it, and sometimes answer bare — all three are accepted. The unwrap is
 * *greedy* on the close (trailing fence) so a Markdown file's own inner blocks
 * survive, but the *open* only matches at the start of the answer (or after one
 * prose line). A bare docs file that contains fences — including one that ends
 * on a fence line — is therefore kept as-is rather than having its leading
 * prose discarded. Anything else (narration, an unclosed fence) lands in Output
 * as a whole-file rewrite when it cannot align. */
export function extractResolvedContent(answer: string): { text: string } | { error: string } {
  const trimmed = answer.trim();
  const text = withTrailingNewline(unwrapFence(trimmed) ?? trimmed);
  if (!text.trim()) return { error: "The agent returned no file content." };
  if (MARKERS.test(text))
    return { error: "The agent left conflict markers in the file — resolve it by hand." };
  return { text };
}

/** Body of a closed, line-starting fence, or null when the answer should be kept as-is. */
function unwrapFence(text: string): string | null {
  const open = OUTER_FENCE.exec(text);
  if (!open || !CLOSE_FENCE.test(text)) return null;
  return text.slice(open[0].length).replace(CLOSE_FENCE, "\n");
}

function withTrailingNewline(text: string): string {
  if (!text) return "";
  return text.endsWith("\n") ? text : `${text}\n`;
}
