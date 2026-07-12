// Lightweight client-side syntax highlighter (GL-212), grown from the diff
// tokenizer ported from the GitLane design prototype. Not a real parser — a
// single per-line regex tagging comments, strings, numbers, identifiers, and
// punctuation, with keyword / type / call-name heuristics — now parametrized by
// language (comment syntax + keyword set) so the file viewer can colour by file
// type. Chosen over a grammar-based library because the viewer renders one DOM
// row per line (virtualized): a whole-file highlighter emits spans that cross
// line boundaries (multi-line strings/comments), which is exactly what makes
// per-line slicing hard. It is also dependency-free and trivially offline/CSP-safe.
//
// The regex must stay total: every input character has to match *some* group, or
// the unmatched char is silently dropped from the rendered line. The final
// alternation (`([\s\S])`) is a catch-all that guarantees losslessness — any char not
// claimed by an earlier group falls through as default-colored text rather than
// vanishing. (Backslash is in the punctuation class; it was once neither
// punctuation nor an identifier char, so `\` was being swallowed — GL-195.)

import { configFor, Language, type LangConfig } from "./languages";

export { Language, languageForPath } from "./languages";

export interface Token {
  text: string;
  color: string;
}

const PALETTE = {
  dark: { cm: "#5c6370", str: "#d99a6a", num: "#d19a66", kw: "#c678dd", fn: "#61afef", ty: "#e5c07b", df: "#b8bfcc", pu: "#7f8696" },
  light: { cm: "#9098a5", str: "#b56305", num: "#8a6d1f", kw: "#a626a4", fn: "#3a6fd8", ty: "#9a6700", df: "#222732", pu: "#5a626d" },
};

// Everything after the (dynamic) comment group is language-independent, so it's
// taken verbatim from one literal — `.source` sidesteps the double-escaping a
// hand-written string would need. Groups here become 2..7 once a comment group
// is prepended: 2 string | 3 number | 4 identifier | 5 whitespace |
// 6 punctuation | 7 any single other char (the lossless catch-all — `[\s\S]`,
// not `.`, so it also matches the chars `.` skips without the `s` flag: newline
// and the JS line separators U+2028/U+2029).
const TAIL =
  /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b0x[0-9a-fA-F]+\b|\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([(){}\[\];:,.<>=!+\-*/%&|^?~@\\]+)|([\s\S])/
    .source;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build the per-language token regex: a comment group (group 1) followed by the
 * shared TAIL. When a language has no comment syntax the comment group is
 * `(?!)`, which never matches — keeping group numbering stable without ever
 * producing an empty match that would stall the scan. */
function buildTokenRe(cfg: LangConfig): RegExp {
  const alts: string[] = cfg.lineComment.map((p) => `${escapeRe(p)}[^\\n]*`);
  if (cfg.blockComment) {
    alts.push(`${escapeRe(cfg.blockComment[0])}.*?${escapeRe(cfg.blockComment[1])}`);
  }
  const comment = alts.length > 0 ? alts.join("|") : "(?!)";
  return new RegExp(`(${comment})|${TAIL}`, "g");
}

// Compiled regex per language (stateful `.lastIndex` is reset each call, so one
// cached instance is safe for the single-threaded, non-reentrant scan).
const RE_CACHE = new Map<Language, RegExp>();
const tokenRe = (lang: Language): RegExp => {
  let re = RE_CACHE.get(lang);
  if (!re) {
    re = buildTokenRe(configFor(lang));
    RE_CACHE.set(lang, re);
  }
  return re;
};

/** Tokenize one line of `text` for `lang` (default {@link Language.Generic},
 * whose config reproduces the original diff tokenizer). Lossless: concatenating
 * the returned token texts always reproduces the input exactly. */
export function highlight(text: string, dark: boolean, lang: Language = Language.Generic): Token[] {
  if (text === "") return [];
  const cfg = configFor(lang);
  const p = dark ? PALETTE.dark : PALETTE.light;
  const re = tokenRe(lang);
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    // A zero-width match would loop forever; the catch-all `([\s\S])` makes this
    // unreachable in practice, but the guard keeps a future regex edit safe.
    if (m[0] === "") break;
    if (m[1]) out.push({ text: m[1], color: p.cm });
    else if (m[2]) out.push({ text: m[2], color: p.str });
    else if (m[3]) out.push({ text: m[3], color: p.num });
    else if (m[4]) {
      const w = m[4];
      const after = text.charAt(re.lastIndex);
      if (cfg.keywords.has(w)) out.push({ text: w, color: p.kw });
      else if (after === "(") out.push({ text: w, color: p.fn });
      else if (/^[A-Z]/.test(w)) out.push({ text: w, color: p.ty });
      else out.push({ text: w, color: p.df });
    } else if (m[5]) out.push({ text: m[5], color: p.df });
    else if (m[6]) out.push({ text: m[6], color: p.pu });
    else if (m[7]) out.push({ text: m[7], color: p.df });
    else break;
  }
  return out;
}
