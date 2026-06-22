// Lightweight client-side syntax highlighter for diff lines, ported verbatim
// from the GitLane design prototype so token colors match the mockup. Not a
// real parser — a single regex tagging comments, strings, numbers, identifiers,
// and punctuation, with keyword / type / call-name heuristics.
//
// The regex must stay total: every input character has to match *some* group, or
// the unmatched char is silently dropped from the rendered line. The final
// alternation (`(.)`) is a catch-all that guarantees losslessness — any char not
// claimed by an earlier group falls through as default-colored text rather than
// vanishing. (Backslash is now in the punctuation class; previously it was
// neither punctuation nor an identifier char, so `\` was being swallowed.)

export interface Token {
  text: string;
  color: string;
}

const KEYWORDS = new Set(
  (
    "const let var function return if else for while do new typeof instanceof " +
    "import from export default await async class extends implements interface " +
    "type enum public private protected readonly static void null undefined true " +
    "false this super case switch break continue try catch finally throw of in " +
    "as yield fn pub struct impl trait use mut match ref move where Self self"
  ).split(" "),
);

const PALETTE = {
  dark: { cm: "#5c6370", str: "#d99a6a", num: "#d19a66", kw: "#c678dd", fn: "#61afef", ty: "#e5c07b", df: "#b8bfcc", pu: "#7f8696" },
  light: { cm: "#9098a5", str: "#b56305", num: "#8a6d1f", kw: "#a626a4", fn: "#3a6fd8", ty: "#9a6700", df: "#222732", pu: "#5a626d" },
};

// Groups: 1 comment | 2 string | 3 number | 4 identifier | 5 whitespace |
// 6 punctuation | 7 any single other char (lossless catch-all, so no input
// character is ever silently dropped from the rendered line).
const TOKEN_RE =
  /(\/\/[^\n]*)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b0x[0-9a-fA-F]+\b|\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([(){}\[\];:,.<>=!+\-*/%&|^?~@\\]+)|(.)|/g;

export function highlight(text: string, dark: boolean): Token[] {
  if (text === "") return [];
  const p = dark ? PALETTE.dark : PALETTE.light;
  const out: Token[] = [];
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  // The trailing `|` alternative can yield an empty match; bail out then so we
  // don't loop forever at the end of the string.
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m[0] === "") break;
    if (m[1]) out.push({ text: m[1], color: p.cm });
    else if (m[2]) out.push({ text: m[2], color: p.str });
    else if (m[3]) out.push({ text: m[3], color: p.num });
    else if (m[4]) {
      const w = m[4];
      const after = text.charAt(TOKEN_RE.lastIndex);
      if (KEYWORDS.has(w)) out.push({ text: w, color: p.kw });
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
