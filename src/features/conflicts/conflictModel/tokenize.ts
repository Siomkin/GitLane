// Minimal syntax tokenisation for the conflict panes. Deliberately not the
// full diff highlighter: these panes render short, already-split lines.

import type { Token } from "./types";
const KEYWORDS = new Set([
  "import", "from", "const", "let", "var", "function", "export", "type", "as", "return",
  "if", "else", "void", "new", "true", "false", "await", "async", "interface", "extends",
  "null", "class", "for", "while", "switch", "case", "break", "continue", "default", "this",
]);

const TOKEN_CLASS: Record<string, string> = {
  plain: "text-neutral-700 dark:text-neutral-200",
  kw: "text-violet-600 dark:text-violet-400",
  str: "text-amber-600 dark:text-amber-400",
  com: "text-neutral-400 italic",
  num: "text-teal-600 dark:text-teal-400",
  type: "text-sky-600 dark:text-sky-400",
  punct: "text-neutral-500 dark:text-neutral-400",
};

const TOKEN_RE =
  /(\s+)|(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\d+(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)|([^\sA-Za-z0-9_$])/g;

/** Lightweight, language-agnostic syntax tokenization for a single code line —
 * good enough to give conflict hunks the same readable colouring as the diff
 * viewer without pulling in a full highlighter. */
export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line))) {
    let cls = "plain";
    let value: string;
    if (match[1]) {
      cls = "plain";
      value = match[1];
    } else if (match[2]) {
      cls = "com";
      value = match[2];
    } else if (match[3]) {
      cls = "str";
      value = match[3];
    } else if (match[4]) {
      cls = "num";
      value = match[4];
    } else if (match[5]) {
      value = match[5];
      cls = KEYWORDS.has(value) ? "kw" : /^[A-Z]/.test(value) ? "type" : "plain";
    } else {
      cls = "punct";
      value = match[6];
    }
    out.push({ v: value, cls: TOKEN_CLASS[cls] });
  }
  if (out.length === 0) out.push({ v: " ", cls: "" });
  return out;
}
